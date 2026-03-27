import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryCategory, RelationType, SupermemoryConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryRow = {
  id: string;
  text: string;
  vector: Float64Array | null;
  importance: number;
  category: MemoryCategory;
  container_tag: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  is_superseded: boolean;
  access_count: number;
  last_accessed_at: number | null;
};

export type EntityRow = {
  id: string;
  name: string;
  type: string;
  first_seen: number;
  last_seen: number;
};

export type EntityMentionRow = {
  memory_id: string;
  entity_id: string;
};

export type RelationshipRow = {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: RelationType;
  confidence: number;
  created_at: number;
};

export type ProfileCacheRow = {
  profile_type: "static" | "dynamic";
  content: string;
  updated_at: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function requireNodeSqlite(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite");
  } catch {
    throw new Error("node:sqlite is not available in this Node.js build");
  }
}

function float64ToBlob(arr: Float64Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function blobToFloat64(buf: Buffer | Uint8Array): Float64Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float64Array(ab);
}

// ---------------------------------------------------------------------------
// MemoryDB
// ---------------------------------------------------------------------------

export class MemoryDB {
  private db: DatabaseSync;
  private vectorDims: number;
  private vecAvailable = false;

  constructor(
    private readonly cfg: SupermemoryConfig,
    vectorDims: number,
  ) {
    this.vectorDims = vectorDims;
    const dbPath = cfg.dbPath;
    ensureDir(path.dirname(dbPath));
    const sqlite = requireNodeSqlite();
    this.db = new sqlite.DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initSchema();
    this.tryLoadVec();
  }

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        vector BLOB,
        importance REAL NOT NULL DEFAULT 0.5,
        category TEXT NOT NULL DEFAULT 'other',
        container_tag TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        is_superseded INTEGER NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entity_mentions (
        memory_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        PRIMARY KEY (memory_id, entity_id),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS profile_cache (
        profile_type TEXT PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embedding_cache (
        hash TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_container ON memories(container_tag);
      CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(is_superseded);
      CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
    `);

    // FTS5 for keyword search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        text,
        category UNINDEXED,
        content=memories,
        content_rowid=rowid
      );
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, id, text, category)
          VALUES (new.rowid, new.id, new.text, new.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, text, category)
          VALUES ('delete', old.rowid, old.id, old.text, old.category);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, text, category)
          VALUES ('delete', old.rowid, old.id, old.text, old.category);
        INSERT INTO memories_fts(rowid, id, text, category)
          VALUES (new.rowid, new.id, new.text, new.category);
      END;
    `);
  }

  private tryLoadVec(): void {
    try {
      // sqlite-vec extension — same pattern as memory-core
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
          id TEXT PRIMARY KEY,
          vector float[${this.vectorDims}]
        );
      `);
      this.vecAvailable = true;
    } catch {
      // sqlite-vec not available — vector search disabled, FTS-only mode
      this.vecAvailable = false;
    }
  }

  get isVectorAvailable(): boolean {
    return this.vecAvailable;
  }

  // -----------------------------------------------------------------------
  // Memories CRUD
  // -----------------------------------------------------------------------

  storeMemory(params: {
    text: string;
    vector?: Float64Array;
    importance?: number;
    category?: MemoryCategory;
    containerTag?: string;
    expiresAt?: number | null;
  }): MemoryRow {
    const id = randomUUID();
    const now = Date.now();
    const importance = params.importance ?? 0.5;
    const category = params.category ?? "other";
    const containerTag = params.containerTag ?? "default";
    const vectorBlob = params.vector ? float64ToBlob(params.vector) : null;

    this.db
      .prepare(
        `INSERT INTO memories (id, text, vector, importance, category, container_tag,
         created_at, updated_at, expires_at, is_superseded, access_count, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
      )
      .run(id, params.text, vectorBlob, importance, category, containerTag, now, now, params.expiresAt ?? null);

    if (this.vecAvailable && params.vector) {
      this.db
        .prepare(`INSERT INTO memories_vec (id, vector) VALUES (?, ?)`)
        .run(id, float64ToBlob(params.vector));
    }

    return {
      id,
      text: params.text,
      vector: params.vector ?? null,
      importance,
      category,
      container_tag: containerTag,
      created_at: now,
      updated_at: now,
      expires_at: params.expiresAt ?? null,
      is_superseded: false,
      access_count: 0,
      last_accessed_at: null,
    };
  }

  getMemory(id: string): MemoryRow | null {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToMemory(row);
  }

  deleteMemory(id: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    if (this.vecAvailable) {
      this.db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(id);
    }
    const result = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return (result as unknown as { changes: number }).changes > 0;
  }

  markSuperseded(id: string): void {
    this.db.prepare(`UPDATE memories SET is_superseded = 1, updated_at = ? WHERE id = ?`).run(Date.now(), id);
  }

  bumpAccessCount(id: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      )
      .run(now, id);
  }

  countMemories(containerTag?: string): number {
    if (containerTag) {
      const row = this.db
        .prepare(`SELECT COUNT(*) as cnt FROM memories WHERE container_tag = ? AND is_superseded = 0`)
        .get(containerTag) as { cnt: number };
      return row.cnt;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM memories WHERE is_superseded = 0`)
      .get() as { cnt: number };
    return row.cnt;
  }

  listActiveMemories(limit = 100, offset = 0, containerTag?: string): MemoryRow[] {
    const sql = containerTag
      ? `SELECT * FROM memories WHERE is_superseded = 0 AND container_tag = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM memories WHERE is_superseded = 0
         ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const args = containerTag ? [containerTag, limit, offset] : [limit, offset];
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMemory(r));
  }

  // -----------------------------------------------------------------------
  // Vector search
  // -----------------------------------------------------------------------

  vectorSearch(
    queryVector: Float64Array,
    limit: number,
    minScore: number,
  ): Array<{ id: string; score: number }> {
    if (!this.vecAvailable) return [];
    const vectorBlob = float64ToBlob(queryVector);
    const rows = this.db
      .prepare(
        `SELECT id, distance FROM memories_vec WHERE vector MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(vectorBlob, limit * 2) as Array<{ id: string; distance: number }>;

    return rows
      .map((r) => ({
        id: r.id,
        score: 1 / (1 + r.distance),
      }))
      .filter((r) => r.score >= minScore);
  }

  // -----------------------------------------------------------------------
  // FTS search
  // -----------------------------------------------------------------------

  ftsSearch(query: string, limit: number): Array<{ id: string; score: number }> {
    const sanitized = query.replace(/['"]/g, "").trim();
    if (!sanitized) return [];
    const terms = sanitized.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t}"`).join(" OR ");

    try {
      const rows = this.db
        .prepare(
          `SELECT id, rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{ id: string; rank: number }>;

      if (rows.length === 0) return [];
      const maxAbsRank = Math.max(...rows.map((r) => Math.abs(r.rank)));
      return rows.map((r) => ({
        id: r.id,
        score: maxAbsRank > 0 ? Math.abs(r.rank) / maxAbsRank : 0.5,
      }));
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Entities
  // -----------------------------------------------------------------------

  upsertEntity(name: string, type: string): EntityRow {
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT * FROM entities WHERE name = ? COLLATE NOCASE AND type = ?`)
      .get(name, type) as Record<string, unknown> | undefined;

    if (existing) {
      this.db.prepare(`UPDATE entities SET last_seen = ? WHERE id = ?`).run(now, existing.id);
      return {
        id: existing.id as string,
        name: existing.name as string,
        type: existing.type as string,
        first_seen: existing.first_seen as number,
        last_seen: now,
      };
    }

    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO entities (id, name, type, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name, type, now, now);
    return { id, name, type, first_seen: now, last_seen: now };
  }

  linkEntityToMemory(memoryId: string, entityId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_mentions (memory_id, entity_id) VALUES (?, ?)`,
      )
      .run(memoryId, entityId);
  }

  getEntitiesForMemory(memoryId: string): EntityRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN entity_mentions em ON em.entity_id = e.id
         WHERE em.memory_id = ?`,
      )
      .all(memoryId) as EntityRow[];
  }

  getMemoriesForEntity(entityId: string): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN entity_mentions em ON em.memory_id = m.id
         WHERE em.entity_id = ? AND m.is_superseded = 0
         ORDER BY m.created_at DESC`,
      )
      .all(entityId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMemory(r));
  }

  findEntityByName(name: string): EntityRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM entities WHERE name = ? COLLATE NOCASE`)
        .get(name) as EntityRow | undefined) ?? null
    );
  }

  // -----------------------------------------------------------------------
  // Relationships
  // -----------------------------------------------------------------------

  addRelationship(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    confidence = 1.0,
  ): RelationshipRow {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO relationships (id, source_id, target_id, relation_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sourceId, targetId, relationType, confidence, now);

    if (relationType === "updates") {
      this.markSuperseded(targetId);
    }

    return { id, source_id: sourceId, target_id: targetId, relation_type: relationType, confidence, created_at: now };
  }

  getRelationshipsForMemory(memoryId: string): RelationshipRow[] {
    return this.db
      .prepare(
        `SELECT * FROM relationships WHERE source_id = ? OR target_id = ? ORDER BY created_at DESC`,
      )
      .all(memoryId, memoryId) as RelationshipRow[];
  }

  getRelatedMemoryIds(memoryId: string, maxHops = 2): Set<string> {
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: memoryId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id) || current.depth > maxHops) continue;
      visited.add(current.id);

      const rels = this.db
        .prepare(`SELECT source_id, target_id FROM relationships WHERE source_id = ? OR target_id = ?`)
        .all(current.id, current.id) as Array<{ source_id: string; target_id: string }>;

      for (const rel of rels) {
        const next = rel.source_id === current.id ? rel.target_id : rel.source_id;
        if (!visited.has(next)) {
          queue.push({ id: next, depth: current.depth + 1 });
        }
      }
    }

    visited.delete(memoryId);
    return visited;
  }

  // -----------------------------------------------------------------------
  // Profile cache
  // -----------------------------------------------------------------------

  getProfileCache(profileType: "static" | "dynamic"): ProfileCacheRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM profile_cache WHERE profile_type = ?`)
        .get(profileType) as ProfileCacheRow | undefined) ?? null
    );
  }

  setProfileCache(profileType: "static" | "dynamic", content: string[]): void {
    const now = Date.now();
    const json = JSON.stringify(content);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO profile_cache (profile_type, content, updated_at) VALUES (?, ?, ?)`,
      )
      .run(profileType, json, now);
  }

  // -----------------------------------------------------------------------
  // Embedding cache
  // -----------------------------------------------------------------------

  getCachedEmbedding(hash: string): Float64Array | null {
    const row = this.db
      .prepare(`SELECT vector FROM embedding_cache WHERE hash = ?`)
      .get(hash) as { vector: Buffer } | undefined;
    if (!row) return null;
    return blobToFloat64(row.vector);
  }

  setCachedEmbedding(hash: string, vector: Float64Array): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO embedding_cache (hash, vector, created_at) VALUES (?, ?, ?)`)
      .run(hash, float64ToBlob(vector), Date.now());
  }

  // -----------------------------------------------------------------------
  // Maintenance
  // -----------------------------------------------------------------------

  deleteExpiredMemories(): number {
    const now = Date.now();
    const expired = this.db
      .prepare(`SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .all(now) as Array<{ id: string }>;

    for (const row of expired) {
      this.deleteMemory(row.id);
    }
    return expired.length;
  }

  deleteDecayedMemories(decayDays: number, minImportance = 0.3): number {
    const cutoff = Date.now() - decayDays * 24 * 60 * 60 * 1000;
    const candidates = this.db
      .prepare(
        `SELECT id FROM memories
         WHERE importance < ? AND access_count = 0 AND created_at < ? AND is_superseded = 0`,
      )
      .all(minImportance, cutoff) as Array<{ id: string }>;

    for (const row of candidates) {
      this.deleteMemory(row.id);
    }
    return candidates.length;
  }

  wipeAll(): void {
    this.db.exec(`DELETE FROM relationships`);
    this.db.exec(`DELETE FROM entity_mentions`);
    this.db.exec(`DELETE FROM entities`);
    this.db.exec(`DELETE FROM embedding_cache`);
    this.db.exec(`DELETE FROM profile_cache`);
    if (this.vecAvailable) {
      this.db.exec(`DELETE FROM memories_vec`);
    }
    this.db.exec(`DELETE FROM memories`);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  stats(): {
    totalMemories: number;
    activeMemories: number;
    supersededMemories: number;
    entities: number;
    relationships: number;
    vectorAvailable: boolean;
  } {
    const total = (this.db.prepare(`SELECT COUNT(*) as cnt FROM memories`).get() as { cnt: number }).cnt;
    const active = (
      this.db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE is_superseded = 0`).get() as { cnt: number }
    ).cnt;
    const entities = (this.db.prepare(`SELECT COUNT(*) as cnt FROM entities`).get() as { cnt: number }).cnt;
    const rels = (this.db.prepare(`SELECT COUNT(*) as cnt FROM relationships`).get() as { cnt: number }).cnt;

    return {
      totalMemories: total,
      activeMemories: active,
      supersededMemories: total - active,
      entities,
      relationships: rels,
      vectorAvailable: this.vecAvailable,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private rowToMemory(row: Record<string, unknown>): MemoryRow {
    return {
      id: row.id as string,
      text: row.text as string,
      vector: row.vector ? blobToFloat64(row.vector as Buffer) : null,
      importance: row.importance as number,
      category: row.category as MemoryCategory,
      container_tag: row.container_tag as string,
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
      expires_at: (row.expires_at as number | null) ?? null,
      is_superseded: !!(row.is_superseded as number),
      access_count: row.access_count as number,
      last_accessed_at: (row.last_accessed_at as number | null) ?? null,
    };
  }
}
