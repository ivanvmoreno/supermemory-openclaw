import type { MemoryCategory, RelationType } from "./config.ts";
import type { MemoryDB, MemoryRow } from "./db.ts";
import type { EmbeddingProvider } from "./embeddings.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtractedEntity = {
  name: string;
  type: string;
};

export type ExtractedMemoryInfo = {
  category: MemoryCategory;
  importance: number;
  entities: ExtractedEntity[];
  expiresAt: number | null;
};

export type DetectedRelationship = {
  targetId: string;
  relationType: RelationType;
  confidence: number;
};

// ---------------------------------------------------------------------------
// Pattern-based entity extraction
// ---------------------------------------------------------------------------

const PERSON_PATTERNS = [
  /\b(?:my (?:friend|colleague|boss|partner|wife|husband|brother|sister|mom|dad|manager|coworker))\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:is my|told me|said|mentioned|works at|lives in)/g,
  /\b(?:with|from|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
];

const EMAIL_PATTERN = /[\w.-]+@[\w.-]+\.\w+/g;
const PHONE_PATTERN = /\+?\d{10,}/g;
const URL_PATTERN = /https?:\/\/[^\s<>]+/g;

const PROJECT_PATTERNS = [
  /\b(?:project|repo|repository|codebase|app|application|service)\s+["']?([A-Za-z][\w-]+)["']?/gi,
  /\bworking on\s+["']?([A-Za-z][\w-]+)["']?/gi,
];

const TECH_PATTERNS = [
  /\b(TypeScript|JavaScript|Python|Rust|Go|Java|C\+\+|React|Vue|Angular|Svelte|Node\.js|Deno|Bun|Docker|Kubernetes|PostgreSQL|MySQL|SQLite|Redis|MongoDB|GraphQL|REST|gRPC|AWS|Azure|GCP|Terraform|Ansible)\b/gi,
];

const PREFERENCE_PATTERNS = [
  /\bi (?:prefer|like|love|enjoy|hate|dislike|want|need|always|never)\b/i,
  /\bmy (?:preference|favorite|go-to|default)\b/i,
];

const DECISION_PATTERNS = [
  /\b(?:decided|will use|going with|chose|switched to|moving to|adopted)\b/i,
  /\blet's (?:use|go with|switch to|try)\b/i,
];

const TEMPORAL_PATTERNS: Array<{ pattern: RegExp; offsetMs: number }> = [
  { pattern: /\btomorrow\b/i, offsetMs: 2 * 24 * 60 * 60 * 1000 },
  { pattern: /\btonight\b/i, offsetMs: 24 * 60 * 60 * 1000 },
  { pattern: /\btoday\b/i, offsetMs: 24 * 60 * 60 * 1000 },
  { pattern: /\bthis week\b/i, offsetMs: 7 * 24 * 60 * 60 * 1000 },
  { pattern: /\bnext week\b/i, offsetMs: 14 * 24 * 60 * 60 * 1000 },
  { pattern: /\bthis month\b/i, offsetMs: 31 * 24 * 60 * 60 * 1000 },
];

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  function add(name: string, type: string) {
    const key = `${type}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ name, type });
  }

  // People
  for (const pattern of PERSON_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(regex)) {
      const name = match[1]?.trim();
      if (name && name.length > 1 && name.length < 50) {
        add(name, "person");
      }
    }
  }

  // Email addresses
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    add(match[0], "email");
  }

  // Phone numbers
  for (const match of text.matchAll(PHONE_PATTERN)) {
    add(match[0], "phone");
  }

  // URLs
  for (const match of text.matchAll(URL_PATTERN)) {
    add(match[0], "url");
  }

  // Projects
  for (const pattern of PROJECT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(regex)) {
      const name = match[1]?.trim();
      if (name && name.length > 1 && name.length < 50) {
        add(name, "project");
      }
    }
  }

  // Technologies
  for (const pattern of TECH_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(regex)) {
      add(match[1], "technology");
    }
  }

  return entities;
}

// ---------------------------------------------------------------------------
// Category & importance detection
// ---------------------------------------------------------------------------

export function detectCategory(text: string): MemoryCategory {
  if (PREFERENCE_PATTERNS.some((p) => p.test(text))) return "preference";
  if (DECISION_PATTERNS.some((p) => p.test(text))) return "decision";
  if (EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text) || PERSON_PATTERNS.some((p) => new RegExp(p.source, p.flags).test(text))) return "entity";
  if (PROJECT_PATTERNS.some((p) => new RegExp(p.source, p.flags).test(text))) return "project";
  if (/\b(?:always|never|remember|rule|instruction|must|should)\b/i.test(text)) return "instruction";
  if (/\b(?:is|are|has|have|was|were|does|did)\b/i.test(text)) return "fact";
  return "other";
}

export function detectImportance(text: string, category: MemoryCategory): number {
  let importance = 0.5;

  // Explicit memory requests are high importance
  if (/\b(?:remember|don't forget|important|critical|always|never)\b/i.test(text)) {
    importance += 0.3;
  }

  // Category-based adjustments
  if (category === "preference" || category === "decision") importance += 0.1;
  if (category === "entity") importance += 0.15;
  if (category === "instruction") importance += 0.2;

  // Length-based: very short or very long → lower
  if (text.length < 20) importance -= 0.1;
  if (text.length > 1000) importance -= 0.05;

  return Math.max(0, Math.min(1, importance));
}

// ---------------------------------------------------------------------------
// Temporal expiration detection
// ---------------------------------------------------------------------------

export function detectExpiration(text: string, referenceTimeMs = Date.now()): number | null {
  for (const { pattern, offsetMs } of TEMPORAL_PATTERNS) {
    if (pattern.test(text)) {
      return referenceTimeMs + offsetMs;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Full extraction pipeline
// ---------------------------------------------------------------------------

export function extractMemoryInfo(
  text: string,
  options?: { referenceTimeMs?: number },
): ExtractedMemoryInfo {
  const entities = extractEntities(text);
  const category = detectCategory(text);
  const importance = detectImportance(text, category);
  const expiresAt = detectExpiration(text, options?.referenceTimeMs);

  return { category, importance, entities, expiresAt };
}

// ---------------------------------------------------------------------------
// Relationship detection
// ---------------------------------------------------------------------------

const CONTRADICTION_INDICATORS = [
  /\b(?:actually|no longer|not anymore|changed|moved|switched|left|quit|stopped)\b/i,
  /\b(?:instead|rather than|but now|now (?:i|we|he|she|they))\b/i,
];

const EXTENSION_INDICATORS = [
  /\b(?:also|additionally|moreover|furthermore|plus|and|as well)\b/i,
  /\b(?:specifically|in particular|for example|such as)\b/i,
];

export async function detectRelationships(
  newMemory: MemoryRow,
  db: MemoryDB,
  _embeddings: EmbeddingProvider,
): Promise<DetectedRelationship[]> {
  const relationships: DetectedRelationship[] = [];

  // Get entities from new memory
  const newEntities = extractEntities(newMemory.text);
  if (newEntities.length === 0) return relationships;

  // Find existing memories that share entities
  for (const entity of newEntities) {
    const existingEntity = db.findEntityByName(entity.name);
    if (!existingEntity) continue;

    const relatedMemories = db.getMemoriesForEntity(existingEntity.id);
    for (const existing of relatedMemories) {
      if (existing.id === newMemory.id) continue;

      // Check if new memory contradicts/updates existing
      const isContradiction = CONTRADICTION_INDICATORS.some((p) => p.test(newMemory.text));
      if (isContradiction) {
        // Use vector similarity to confirm they're about the same topic
        if (newMemory.vector && existing.vector) {
          const similarity = cosineSimilarity(newMemory.vector, existing.vector);
          if (similarity > 0.5) {
            relationships.push({
              targetId: existing.id,
              relationType: "updates",
              confidence: Math.min(1, similarity + 0.2),
            });
            continue;
          }
        }
      }

      // Check if new memory extends existing
      const isExtension = EXTENSION_INDICATORS.some((p) => p.test(newMemory.text));
      if (isExtension) {
        if (newMemory.vector && existing.vector) {
          const similarity = cosineSimilarity(newMemory.vector, existing.vector);
          if (similarity > 0.4) {
            relationships.push({
              targetId: existing.id,
              relationType: "extends",
              confidence: similarity,
            });
          }
        }
      }
    }
  }

  return relationships;
}

// ---------------------------------------------------------------------------
// Process new memory: extract, embed, store, link
// ---------------------------------------------------------------------------

export async function processNewMemory(
  text: string,
  db: MemoryDB,
  embeddings: EmbeddingProvider,
  options?: {
    containerTag?: string;
    categoryOverride?: MemoryCategory;
    importanceOverride?: number;
    createdAt?: number;
    updatedAt?: number;
    referenceTimeMs?: number;
  },
): Promise<MemoryRow> {
  const exactDuplicate = db.findExactMemory(text, options?.containerTag ?? "default");
  if (exactDuplicate) {
    db.bumpAccessCount(exactDuplicate.id);
    return exactDuplicate;
  }

  const info = extractMemoryInfo(text, {
    referenceTimeMs: options?.referenceTimeMs ?? options?.createdAt,
  });

  // Embed
  const vector = await embeddings.embed(text);

  // Check for near-duplicates
  const duplicates = db.vectorSearch(vector, 1, 0.95);
  if (duplicates.length > 0) {
    const existing = db.getMemory(duplicates[0].id);
    if (existing) {
      db.bumpAccessCount(existing.id);
      return existing;
    }
  }

  // Store memory
  const memory = db.storeMemory({
    text,
    vector,
    importance: options?.importanceOverride ?? info.importance,
    category: options?.categoryOverride ?? info.category,
    containerTag: options?.containerTag,
    expiresAt: info.expiresAt,
    createdAt: options?.createdAt,
    updatedAt: options?.updatedAt,
  });

  // Link entities
  for (const entity of info.entities) {
    const entityRow = db.upsertEntity(entity.name, entity.type);
    db.linkEntityToMemory(memory.id, entityRow.id);
  }

  // Detect and record relationships
  const relationships = await detectRelationships(memory, db, embeddings);
  for (const rel of relationships) {
    db.addRelationship(memory.id, rel.targetId, rel.relationType, rel.confidence);
  }

  return memory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
