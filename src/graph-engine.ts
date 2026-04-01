import type { MemoryType } from "./config.ts";
import type { MemoryDB, MemoryEntityMentionRow, MemoryRow } from "./db.ts";
import { normalizeEntityAliasText } from "./entity-text.ts";
import type { EmbeddingProvider } from "./embeddings.ts";
import {
  resolveMemoryRelationships,
  type ExtractedEntityMention,
  type ExtractedMemoryCandidate,
  type SemanticLogLike,
  type SemanticRuntimeLike,
  type UpdateResolverCandidate,
} from "./fact-extractor.ts";
import { prepareMemoryTextForStorage } from "./memory-text.ts";

const MAX_MEMORY_TEXT_CHARS = 2000;
const DEDUP_FTS_CANDIDATE_LIMIT = 12;
const LEXICAL_DUPLICATE_SCORE_THRESHOLD = 0.88;
const NEAR_DUPLICATE_VECTOR_THRESHOLD = 0.95;
const UPDATE_VECTOR_MIN_SCORE = 0.55;
const UPDATE_VECTOR_CANDIDATE_LIMIT = 8;
const UPDATE_RESOLVER_CANDIDATE_LIMIT = 12;
const MAX_RELATED_EDGES = 5;

import stopwordsIso from "stopwords-iso";

const DEDUP_TOKEN_PATTERN = /[\p{Letter}\p{Number}]+(?:[.@:/+-][\p{Letter}\p{Number}]+)*/gu;
const DIACRITIC_PATTERN = /\p{Mark}+/gu;

const DEDUP_STOPWORDS = new Set<string>(
  Object.values(stopwordsIso).flat()
);

export async function processNewMemory(
  text: string,
  db: MemoryDB,
  embeddings: EmbeddingProvider,
  options?: {
    memoryTypeOverride?: MemoryType;
    pinnedOverride?: boolean;
    createdAt?: number;
    updatedAt?: number;
    referenceTimeMs?: number;
    semanticRuntime?: SemanticRuntimeLike | null;
    log?: SemanticLogLike;
    semanticMemory?: ExtractedMemoryCandidate | null;
  },
): Promise<MemoryRow | null> {
  const cleanedText = prepareMemoryTextForStorage(text, MAX_MEMORY_TEXT_CHARS);
  if (!cleanedText) return null;

  const memoryType = options?.memoryTypeOverride ?? options?.semanticMemory?.memoryType ?? "fact";
  const pinned = options?.pinnedOverride ?? false;
  const expiresAt =
    memoryType === "episode" ? parseExpiresAtIso(options?.semanticMemory?.expiresAtIso) : null;

  const exactDuplicate = db.findExactMemory(cleanedText);
  if (exactDuplicate) {
    return (
      db.mergeDuplicateMemory({
        id: exactDuplicate.id,
        memoryTypeOverride: options?.memoryTypeOverride,
        pinnedOverride: options?.pinnedOverride,
        expiresAtOverride: memoryType === "episode" ? expiresAt : undefined,
      }) ?? exactDuplicate
    );
  }

  const lexicalDuplicate = findLexicalDuplicate(cleanedText, db);
  if (lexicalDuplicate) {
    return (
      db.mergeDuplicateMemory({
        id: lexicalDuplicate.id,
        memoryTypeOverride: options?.memoryTypeOverride,
        pinnedOverride: options?.pinnedOverride,
        expiresAtOverride: memoryType === "episode" ? expiresAt : undefined,
      }) ?? lexicalDuplicate
    );
  }

  let vector: Float64Array | undefined;
  try {
    vector = await embeddings.embed(cleanedText);
    const nearDuplicate = findNearDuplicate(vector, db);
    if (nearDuplicate) {
      db.bumpAccessCount(nearDuplicate.id);
      return nearDuplicate;
    }
  } catch (err) {
    options?.log?.warn?.(`memory-supermemory: embedding unavailable during dedup/store: ${String(err)}`);
  }

  const memory = db.storeMemory({
    text: cleanedText,
    vector,
    memoryType,
    expiresAt,
    pinned,
    createdAt: options?.createdAt,
    updatedAt: options?.updatedAt,
  });

  const mentions = collectEntityMentions(cleanedText, options?.semanticMemory?.entities ?? []);
  for (const mention of mentions) {
    const normalized = normalizeEntityAliasText(mention.mention);
    if (!normalized) continue;
    const resolved = db.resolveEntityAlias(mention.mention, normalized, mention.kind);
    db.linkAliasToMemory(memory.id, resolved.alias.id);
  }

  const parentMemoryId = await resolveUpdateRelationship(
    memory,
    db,
    options?.semanticRuntime ?? null,
    options?.log,
  );
  if (parentMemoryId) {
    try {
      db.setParentMemoryId(memory.id, parentMemoryId);
    } catch {
      // best-effort metadata only
    }
  }

  addDeterministicRelatedEdges(memory, db, parentMemoryId ? new Set([parentMemoryId]) : new Set());
  return memory;
}

function collectEntityMentions(
  _text: string,
  extracted: ExtractedEntityMention[],
): ExtractedEntityMention[] {
  const merged = new Map<string, ExtractedEntityMention>();

  function add(mention: string, kind: string | null): void {
    const trimmed = mention.trim();
    if (!trimmed) return;
    const normalized = normalizeEntityAliasText(trimmed);
    if (!normalized) return;

    const existing = merged.get(normalized);
    if (existing) {
      if (!existing.kind && kind) {
        existing.kind = kind;
      }
      return;
    }

    merged.set(normalized, {
      mention: trimmed,
      kind: kind ?? null,
    });
  }

  for (const entity of extracted) {
    add(entity.mention, entity.kind);
  }

  return [...merged.values()];
}

function parseExpiresAtIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function findNearDuplicate(
  vector: Float64Array,
  db: MemoryDB,
): MemoryRow | null {
  const candidates = db.vectorSearch(vector, 4, NEAR_DUPLICATE_VECTOR_THRESHOLD);
  const hydrated = db.getMemoriesByIds(candidates.map((candidate) => candidate.id));
  return hydrated.find((candidate) => !candidate.is_superseded) ?? null;
}

function findLexicalDuplicate(
  text: string,
  db: MemoryDB,
): MemoryRow | null {
  const queryTerms = buildDedupQueryTerms(text);
  if (queryTerms.length === 0) return null;

  const candidates = db.getMemoriesByIds(
    db.ftsSearch(queryTerms.join(" "), DEDUP_FTS_CANDIDATE_LIMIT).map((candidate) => candidate.id),
  );

  let bestCandidate: MemoryRow | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = lexicalDuplicateScore(text, candidate.text);
    if (score > bestScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  return bestScore >= LEXICAL_DUPLICATE_SCORE_THRESHOLD ? bestCandidate : null;
}

function buildDedupQueryTerms(text: string): string[] {
  const tokens = tokenizeForDedup(text);
  const contentTokens = tokens.filter(isContentToken);
  const source = contentTokens.length >= 2 ? contentTokens : tokens;
  return [...new Set(source)].sort((left, right) => right.length - left.length).slice(0, 8);
}

function lexicalDuplicateScore(left: string, right: string): number {
  const leftTokens = tokenizeForDedup(left);
  const rightTokens = tokenizeForDedup(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const leftStructured = new Set(leftTokens.filter(isStructuredToken));
  const rightStructured = new Set(rightTokens.filter(isStructuredToken));
  if (
    leftStructured.size > 0 &&
    rightStructured.size > 0 &&
    setDiceScore(leftStructured, rightStructured) < 1
  ) {
    return 0;
  }

  const leftContent = contentTokensForDedup(leftTokens);
  const rightContent = contentTokensForDedup(rightTokens);
  const contentContainment = setContainmentScore(new Set(leftContent), new Set(rightContent));
  const tokenLcsScore =
    longestCommonSubsequenceLength(leftTokens, rightTokens) /
    Math.max(1, Math.min(leftTokens.length, rightTokens.length));
  const charDice = charNgramDiceScore(
    normalizeForDedup(left).replace(/\s+/g, " ").trim(),
    normalizeForDedup(right).replace(/\s+/g, " ").trim(),
    3,
  );

  return contentContainment * 0.55 + tokenLcsScore * 0.3 + charDice * 0.15;
}

function tokenizeForDedup(text: string): string[] {
  return normalizeForDedup(text).match(DEDUP_TOKEN_PATTERN) ?? [];
}

function normalizeForDedup(text: string): string {
  return text
    .normalize("NFKD")
    .replace(DIACRITIC_PATTERN, "")
    .toLowerCase();
}

function contentTokensForDedup(tokens: string[]): string[] {
  const content = tokens.filter(isContentToken);
  return content.length > 0 ? content : tokens;
}

function isContentToken(token: string): boolean {
  return isStructuredToken(token) || (token.length >= 3 && !DEDUP_STOPWORDS.has(token));
}

function isStructuredToken(token: string): boolean {
  return /[@:/]|\d/.test(token);
}

function setContainmentScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }

  return overlap / Math.min(left.size, right.size);
}

function setDiceScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }

  return (2 * overlap) / (left.size + right.size);
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  const widths = new Array(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= right.length; j++) {
      const previous = widths[j];
      if (left[i - 1] === right[j - 1]) {
        widths[j] = diagonal + 1;
      } else {
        widths[j] = Math.max(widths[j], widths[j - 1]);
      }
      diagonal = previous;
    }
  }

  return widths[right.length];
}

function charNgramDiceScore(left: string, right: string, size: number): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftShingles = buildCharNgrams(left, size);
  const rightShingles = buildCharNgrams(right, size);
  return setDiceScore(leftShingles, rightShingles);
}

function buildCharNgrams(text: string, size: number): Set<string> {
  if (text.length <= size) return new Set([text]);

  const grams = new Set<string>();
  for (let i = 0; i <= text.length - size; i++) {
    grams.add(text.slice(i, i + size));
  }
  return grams;
}

async function resolveUpdateRelationship(
  memory: MemoryRow,
  db: MemoryDB,
  semanticRuntime: SemanticRuntimeLike | null,
  log?: SemanticLogLike,
): Promise<string | null> {
  if (!semanticRuntime || !log) return null;
  if (memory.memory_type === "episode") return null;

  const entityIds = db.getCanonicalEntityIdsForMemory(memory.id);
  const candidates = buildUpdateCandidates(memory, entityIds, db);
  if (candidates.length === 0) return null;

  const decisions = await resolveMemoryRelationships(
    {
      text: memory.text,
      memoryType: memory.memory_type,
      entityIds,
    },
    candidates,
    semanticRuntime,
    log,
  );

  const updateDecision = decisions.find((decision) => decision.relationType === "updates");
  if (!updateDecision) return null;

  db.addRelationship(memory.id, updateDecision.targetId, "updates");
  return updateDecision.targetId;
}

function buildUpdateCandidates(
  memory: MemoryRow,
  entityIds: string[],
  db: MemoryDB,
): UpdateResolverCandidate[] {
  const candidateMap = new Map<
    string,
    { memory: MemoryRow; sharedEntityCount: number; vectorScore: number }
  >();

  function upsertCandidate(candidate: MemoryRow, options?: { sharedEntity?: boolean; vectorScore?: number }) {
    if (candidate.id === memory.id) return;
    if (candidate.memory_type !== memory.memory_type) return;
    if (candidate.is_superseded) return;

    const existing = candidateMap.get(candidate.id);
    if (existing) {
      if (options?.sharedEntity) {
        existing.sharedEntityCount += 1;
      }
      if (options?.vectorScore !== undefined) {
        existing.vectorScore = Math.max(existing.vectorScore, options.vectorScore);
      }
      return;
    }

    candidateMap.set(candidate.id, {
      memory: candidate,
      sharedEntityCount: options?.sharedEntity ? 1 : 0,
      vectorScore: options?.vectorScore ?? 0,
    });
  }

  for (const entityId of entityIds) {
    for (const candidate of db.getMemoriesForEntity(entityId)) {
      upsertCandidate(candidate, { sharedEntity: true });
    }
  }

  if (memory.vector) {
    const vectorCandidates = db.vectorSearch(
      memory.vector,
      UPDATE_VECTOR_CANDIDATE_LIMIT * 2,
      UPDATE_VECTOR_MIN_SCORE,
    );
    const hydrated = db.getMemoriesByIds(vectorCandidates.map((candidate) => candidate.id));
    const byId = new Map(vectorCandidates.map((candidate) => [candidate.id, candidate.score]));
    for (const candidate of hydrated) {
      upsertCandidate(candidate, { vectorScore: byId.get(candidate.id) ?? 0 });
    }
  }

  return [...candidateMap.values()]
    .sort((a, b) => {
      if (a.sharedEntityCount !== b.sharedEntityCount) {
        return b.sharedEntityCount - a.sharedEntityCount;
      }
      if (a.vectorScore !== b.vectorScore) {
        return b.vectorScore - a.vectorScore;
      }
      return b.memory.created_at - a.memory.created_at;
    })
    .slice(0, UPDATE_RESOLVER_CANDIDATE_LIMIT)
    .map((entry) => ({
      id: entry.memory.id,
      text: entry.memory.text,
      memoryType: entry.memory.memory_type,
      entityIds: db.getCanonicalEntityIdsForMemory(entry.memory.id),
      createdAt: entry.memory.created_at,
    }));
}

function addDeterministicRelatedEdges(
  memory: MemoryRow,
  db: MemoryDB,
  excludedTargetIds: Set<string>,
): void {
  const entityIds = db.getCanonicalEntityIdsForMemory(memory.id);
  if (entityIds.length === 0) return;

  const candidateMap = new Map<string, { memory: MemoryRow; sharedEntityCount: number }>();

  for (const entityId of entityIds) {
    for (const candidate of db.getMemoriesForEntity(entityId)) {
      if (candidate.id === memory.id) continue;
      if (candidate.is_superseded) continue;
      if (excludedTargetIds.has(candidate.id)) continue;

      const existing = candidateMap.get(candidate.id);
      if (existing) {
        existing.sharedEntityCount += 1;
      } else {
        candidateMap.set(candidate.id, {
          memory: candidate,
          sharedEntityCount: 1,
        });
      }
    }
  }

  for (const entry of [...candidateMap.values()]
    .sort((a, b) => {
      if (a.sharedEntityCount !== b.sharedEntityCount) {
        return b.sharedEntityCount - a.sharedEntityCount;
      }
      return b.memory.created_at - a.memory.created_at;
    })
    .slice(0, MAX_RELATED_EDGES)) {
    db.addRelationship(memory.id, entry.memory.id, "related");
  }
}

export function buildEntityMergeCandidates(
  entities: Array<{
    id: string;
    canonicalName: string;
    aliases: string[];
  }>,
  embeddingsByEntityId: Map<string, Float64Array>,
): Array<{
  leftEntityId: string;
  leftCanonicalName: string;
  leftAliases: string[];
  rightEntityId: string;
  rightCanonicalName: string;
  rightAliases: string[];
}> {
  const candidates: Array<{
    leftEntityId: string;
    leftCanonicalName: string;
    leftAliases: string[];
    rightEntityId: string;
    rightCanonicalName: string;
    rightAliases: string[];
    score: number;
  }> = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const left = entities[i];
      const right = entities[j];
      const stringScore = stringSimilarity(left.canonicalName, right.canonicalName);
      const embeddingScore = cosineSimilarity(
        embeddingsByEntityId.get(left.id) ?? null,
        embeddingsByEntityId.get(right.id) ?? null,
      );

      if (stringScore < 0.74 && embeddingScore < 0.86) continue;

      candidates.push({
        leftEntityId: left.id,
        leftCanonicalName: left.canonicalName,
        leftAliases: left.aliases,
        rightEntityId: right.id,
        rightCanonicalName: right.canonicalName,
        rightAliases: right.aliases,
        score: Math.max(stringScore, embeddingScore),
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...candidate }) => candidate);
}

function stringSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeEntityAliasText(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalizeEntityAliasText(right).split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  const jaccard = overlap / new Set([...leftTokens, ...rightTokens]).size;
  const foldedEqual = foldForLooseComparison(left) === foldForLooseComparison(right) ? 1 : 0;
  return Math.max(jaccard, foldedEqual);
}

function foldForLooseComparison(value: string): string {
  return normalizeEntityAliasText(value)
    .normalize("NFD")
    .replace(/\p{Mark}+/gu, "");
}

function cosineSimilarity(left: Float64Array | null, right: Float64Array | null): number {
  if (!left || !right || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}

export function formatEntityMergeInputs(
  db: MemoryDB,
  limit = 200,
): Array<{
  id: string;
  canonicalName: string;
  aliases: string[];
}> {
  return db.listCanonicalEntities(limit).map((entity) => ({
    id: entity.id,
    canonicalName: entity.canonical_name,
    aliases: db.getAliasesForEntity(entity.id).map((alias) => alias.surface_text),
  }));
}

export function getEntityIdsForMemoryMentions(mentions: MemoryEntityMentionRow[]): string[] {
  return [...new Set(mentions.map((mention) => mention.entity_id))];
}
