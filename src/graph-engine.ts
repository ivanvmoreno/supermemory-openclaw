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

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

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
  // 1. Relative patterns (tomorrow, this week, etc.)
  for (const { pattern, offsetMs } of TEMPORAL_PATTERNS) {
    if (pattern.test(text)) {
      return referenceTimeMs + offsetMs;
    }
  }

  // 2. "next Tuesday", "next Monday", etc.
  const nextDayMatch = text.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (nextDayMatch) {
    const targetDay = DAY_NAMES.indexOf(nextDayMatch[1].toLowerCase());
    if (targetDay >= 0) {
      const now = new Date(referenceTimeMs);
      const currentDay = now.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      daysUntil += 7; // "next" means the week after
      return referenceTimeMs + daysUntil * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000;
    }
  }

  // 3. Absolute dates: "January 15", "March 3rd", "Dec 25"
  const absoluteDateMatch = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
  );
  if (absoluteDateMatch) {
    const month = MONTH_NAMES[absoluteDateMatch[1].toLowerCase()];
    const day = Number.parseInt(absoluteDateMatch[2], 10);
    if (month !== undefined && day >= 1 && day <= 31) {
      const now = new Date(referenceTimeMs);
      let year = now.getFullYear();
      const target = new Date(year, month, day, 23, 59, 59);
      if (target.getTime() < referenceTimeMs) {
        target.setFullYear(year + 1);
      }
      return target.getTime();
    }
  }

  // 4. ISO-like dates: "2026-04-15", "04/15"
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const target = new Date(
      Number.parseInt(isoMatch[1], 10),
      Number.parseInt(isoMatch[2], 10) - 1,
      Number.parseInt(isoMatch[3], 10),
      23, 59, 59,
    );
    if (!Number.isNaN(target.getTime())) return target.getTime();
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
  const seenTargets = new Set<string>();

  // Get entities from new memory
  const newEntities = extractEntities(newMemory.text);
  if (newEntities.length === 0) return relationships;

  // Find existing memories that share entities
  for (const entity of newEntities) {
    const existingEntity = db.findEntityByName(entity.name);
    if (!existingEntity) continue;

    const relatedMemories = db.getMemoriesForEntity(existingEntity.id);
    for (const existing of relatedMemories) {
      if (existing.id === newMemory.id || seenTargets.has(existing.id)) continue;

      if (!newMemory.vector || !existing.vector) continue;
      const similarity = cosineSimilarity(newMemory.vector, existing.vector);

      // Check if new memory contradicts/updates existing
      const hasContradictionKeywords = CONTRADICTION_INDICATORS.some((p) => p.test(newMemory.text));

      // Implicit update: very high similarity between memories sharing an entity
      // suggests the new fact replaces the old one (even without explicit contradiction words)
      if (hasContradictionKeywords && similarity > 0.5) {
        relationships.push({
          targetId: existing.id,
          relationType: "updates",
          confidence: Math.min(1, similarity + 0.2),
        });
        seenTargets.add(existing.id);
        continue;
      }

      // Semantic-only update detection: if two facts about the same entity
      // are very similar (>0.7), the newer one likely supersedes the older
      if (similarity > 0.7) {
        relationships.push({
          targetId: existing.id,
          relationType: "updates",
          confidence: similarity,
        });
        seenTargets.add(existing.id);
        continue;
      }

      // Check if new memory extends existing
      const isExtension = EXTENSION_INDICATORS.some((p) => p.test(newMemory.text));
      if (isExtension && similarity > 0.4) {
        relationships.push({
          targetId: existing.id,
          relationType: "extends",
          confidence: similarity,
        });
        seenTargets.add(existing.id);
        continue;
      }

      // Derive: moderate similarity between facts sharing an entity suggests a connection
      if (similarity > 0.3 && similarity <= 0.7) {
        relationships.push({
          targetId: existing.id,
          relationType: "derives",
          confidence: similarity * 0.8,
        });
        seenTargets.add(existing.id);
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
    isStatic?: boolean;
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
    isStatic: options?.isStatic,
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
  let parentMemoryId: string | null = null;
  for (const rel of relationships) {
    db.addRelationship(memory.id, rel.targetId, rel.relationType, rel.confidence);
    // Track the first "updates" target as the parent for version chaining
    if (rel.relationType === "updates" && !parentMemoryId) {
      parentMemoryId = rel.targetId;
    }
  }

  // Set parent_memory_id for version chaining if an update was detected
  if (parentMemoryId) {
    try {
      db.setParentMemoryId(memory.id, parentMemoryId);
    } catch {
      // non-critical — version chain is advisory
    }
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
