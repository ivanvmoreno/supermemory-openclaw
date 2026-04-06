import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { MemoryType, RelationType, SupermemoryConfig } from "./config.ts"

export type MemoryRow = {
	id: string
	text: string
	vector: Float64Array | null
	memory_type: MemoryType
	created_at: number
	updated_at: number
	expires_at: number | null
	is_superseded: boolean
	pinned: boolean
	parent_memory_id: string | null
	access_count: number
	last_accessed_at: number | null
}

export type EntityRow = {
	id: string
	canonical_name: string
	kind: string | null
	first_seen: number
	last_seen: number
	merged_into_id: string | null
}

export type EntityAliasRow = {
	id: string
	entity_id: string
	surface_text: string
	normalized_text: string
	kind: string | null
	first_seen: number
	last_seen: number
}

export type EntityMentionRow = {
	memory_id: string
	alias_id: string
}

export type MemoryEntityMentionRow = {
	alias_id: string
	entity_id: string
	surface_text: string
	normalized_text: string
	alias_kind: string | null
	canonical_name: string
	canonical_kind: string | null
}

export type RelationshipRow = {
	id: string
	source_id: string
	target_id: string
	relation_type: RelationType
	created_at: number
}

export type ProfileCacheRow = {
	profile_type: "longTerm" | "recent"
	content: string
	updated_at: number
}

export type VectorBackfillStats = {
	indexed: number
	missingVectors: number
	missingIndexRows: number
	pendingBackfill: number
}

const CURRENT_MEMORY_COLUMNS = [
	"id",
	"text",
	"vector",
	"memory_type",
	"created_at",
	"updated_at",
	"expires_at",
	"is_superseded",
	"pinned",
	"parent_memory_id",
	"access_count",
	"last_accessed_at",
] as const

const CURRENT_ENTITY_COLUMNS = [
	"id",
	"canonical_name",
	"kind",
	"first_seen",
	"last_seen",
	"merged_into_id",
] as const

const CURRENT_ENTITY_ALIAS_COLUMNS = [
	"id",
	"entity_id",
	"surface_text",
	"normalized_text",
	"kind",
	"first_seen",
	"last_seen",
] as const

const CURRENT_ENTITY_MENTION_COLUMNS = ["memory_id", "alias_id"] as const

const CURRENT_RELATIONSHIP_COLUMNS = [
	"id",
	"source_id",
	"target_id",
	"relation_type",
	"created_at",
] as const

const PLUGIN_OBJECT_NAMES = [
	"memories_ai",
	"memories_ad",
	"memories_au",
	"memories_vec",
	"memories_fts",
	"memories",
	"entity_mentions",
	"entity_aliases",
	"entities",
	"relationships",
	"profile_cache",
	"embedding_cache",
] as const

function ensureDir(dirPath: string): void {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true })
	}
}

const esmRequire = createRequire(import.meta.url)

function requireNodeSqlite(): typeof import("node:sqlite") {
	try {
		return esmRequire("node:sqlite")
	} catch {
		throw new Error("node:sqlite is not available in this Node.js build")
	}
}

function float64ToBlob(arr: Float64Array): Buffer {
	return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function blobToFloat64(buf: Buffer | Uint8Array): Float64Array {
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
	return new Float64Array(ab)
}

export class MemoryDB {
	private db: DatabaseSync
	private vectorDims: number
	private vecAvailable = false

	constructor(cfg: SupermemoryConfig, vectorDims: number) {
		this.vectorDims = vectorDims
		ensureDir(path.dirname(cfg.dbPath))
		const sqlite = requireNodeSqlite()
		this.db = new sqlite.DatabaseSync(cfg.dbPath, {
			allowExtension: cfg.embedding.enabled,
		})
		this.db.exec("PRAGMA journal_mode = WAL")
		this.db.exec("PRAGMA foreign_keys = ON")
		this.initSchema()
		if (cfg.embedding.enabled) {
			this.tryLoadVec()
		} else {
			this.vecAvailable = false
		}
	}

	private initSchema(): void {
		if (this.schemaNeedsReset()) {
			this.resetPluginSchema()
		}

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        vector BLOB,
        memory_type TEXT NOT NULL DEFAULT 'fact',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        is_superseded INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        parent_memory_id TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        kind TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        merged_into_id TEXT,
        FOREIGN KEY (merged_into_id) REFERENCES entities(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS entity_aliases (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        surface_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL UNIQUE,
        kind TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS entity_mentions (
        memory_id TEXT NOT NULL,
        alias_id TEXT NOT NULL,
        PRIMARY KEY (memory_id, alias_id),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (alias_id) REFERENCES entity_aliases(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
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

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(is_superseded);
      CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
      CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON entities(last_seen);
      CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON entities(merged_into_id);
      CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity ON entity_aliases(entity_id);
      CREATE INDEX IF NOT EXISTS idx_entity_aliases_normalized ON entity_aliases(normalized_text);
      CREATE INDEX IF NOT EXISTS idx_entity_mentions_alias ON entity_mentions(alias_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
    `)

		this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        text,
        memory_type UNINDEXED,
        content=memories,
        content_rowid=rowid
      );
    `)

		this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, id, text, memory_type)
          VALUES (new.rowid, new.id, new.text, new.memory_type);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, text, memory_type)
          VALUES ('delete', old.rowid, old.id, old.text, old.memory_type);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, id, text, memory_type)
          VALUES ('delete', old.rowid, old.id, old.text, old.memory_type);
        INSERT INTO memories_fts(rowid, id, text, memory_type)
          VALUES (new.rowid, new.id, new.text, new.memory_type);
      END;
    `)

		try {
			this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`)
		} catch {}
	}

	private schemaNeedsReset(): boolean {
		const objects = this.db
			.prepare(
				`SELECT name, sql FROM sqlite_master
         WHERE name IN (${PLUGIN_OBJECT_NAMES.map(() => "?").join(", ")})`,
			)
			.all(...PLUGIN_OBJECT_NAMES) as Array<{
			name: string
			sql: string | null
		}>

		if (objects.length === 0) return false

		for (const required of [
			"memories",
			"entities",
			"entity_aliases",
			"entity_mentions",
			"relationships",
		]) {
			if (!objects.some((obj) => obj.name === required)) {
				return true
			}
		}

		if (!this.tableColumnsMatch("memories", CURRENT_MEMORY_COLUMNS)) return true
		if (!this.tableColumnsMatch("entities", CURRENT_ENTITY_COLUMNS)) return true
		if (!this.tableColumnsMatch("entity_aliases", CURRENT_ENTITY_ALIAS_COLUMNS))
			return true
		if (
			!this.tableColumnsMatch("entity_mentions", CURRENT_ENTITY_MENTION_COLUMNS)
		)
			return true
		if (!this.tableColumnsMatch("relationships", CURRENT_RELATIONSHIP_COLUMNS))
			return true

		const ftsSql =
			objects.find((obj) => obj.name === "memories_fts")?.sql?.toLowerCase() ??
			""
		if (ftsSql.length > 0 && !ftsSql.includes("memory_type")) {
			return true
		}

		return false
	}

	private tableColumnsMatch(
		tableName: string,
		expected: readonly string[],
	): boolean {
		const rows = this.db
			.prepare(`PRAGMA table_info(${tableName})`)
			.all() as Array<{ name: string }>
		const actual = rows.map((row) => row.name)
		return actual.join("|") === expected.join("|")
	}

	private resetPluginSchema(): void {
		this.db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memories_vec;
      DROP TABLE IF EXISTS memories_fts;
      DROP TABLE IF EXISTS relationships;
      DROP TABLE IF EXISTS entity_mentions;
      DROP TABLE IF EXISTS entity_aliases;
      DROP TABLE IF EXISTS entities;
      DROP TABLE IF EXISTS embedding_cache;
      DROP TABLE IF EXISTS profile_cache;
      DROP TABLE IF EXISTS memories;
    `)
	}

	private tryLoadVec(): void {
		try {
			try {
				let sqliteVec: { load: (db: DatabaseSync) => void }
				try {
					sqliteVec = esmRequire("sqlite-vec")
				} catch {
					// If not in plugin's node_modules, resolve from the host OpenClaw installation
					// process.argv[1] points to the openclaw CLI executable entry point.
					const hostRequire = createRequire(process.argv[1] || import.meta.url)
					sqliteVec = hostRequire("sqlite-vec")
				}
				this.db.enableLoadExtension(true)
				sqliteVec.load(this.db)
				this.db.enableLoadExtension(false)
			} catch {
				// Ignore load error; fall back to trying to create the table
				// in case vec0 is already available (e.g. statically linked)
			}

			this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
          id TEXT PRIMARY KEY,
          vector float[${this.vectorDims}] distance_metric=cosine
        );
      `)
			this.vecAvailable = true
		} catch {
			this.vecAvailable = false
		}
	}

	get isVectorAvailable(): boolean {
		return this.vecAvailable
	}

	private upsertVectorIndex(id: string, vector: Float64Array): void {
		if (!this.vecAvailable) return

		this.db.prepare("DELETE FROM memories_vec WHERE id = ?").run(id)
		this.db
			.prepare("INSERT INTO memories_vec (id, vector) VALUES (?, ?)")
			.run(id, float64ToBlob(vector))
	}

	storeMemory(params: {
		text: string
		vector?: Float64Array
		memoryType?: MemoryType
		expiresAt?: number | null
		pinned?: boolean
		parentMemoryId?: string | null
		createdAt?: number
		updatedAt?: number
	}): MemoryRow {
		const id = randomUUID()
		const createdAt = params.createdAt ?? Date.now()
		const updatedAt = params.updatedAt ?? createdAt
		const memoryType = params.memoryType ?? "fact"
		const pinned = params.pinned ? 1 : 0
		const parentMemoryId = params.parentMemoryId ?? null
		const vectorBlob = params.vector ? float64ToBlob(params.vector) : null

		this.db
			.prepare(
				`INSERT INTO memories (
           id,
           text,
           vector,
           memory_type,
           created_at,
           updated_at,
           expires_at,
           is_superseded,
           pinned,
           parent_memory_id,
           access_count,
           last_accessed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, NULL)`,
			)
			.run(
				id,
				params.text,
				vectorBlob,
				memoryType,
				createdAt,
				updatedAt,
				params.expiresAt ?? null,
				pinned,
				parentMemoryId,
			)

		if (this.vecAvailable && params.vector) {
			this.upsertVectorIndex(id, params.vector)
		}

		return {
			id,
			text: params.text,
			vector: params.vector ?? null,
			memory_type: memoryType,
			created_at: createdAt,
			updated_at: updatedAt,
			expires_at: params.expiresAt ?? null,
			is_superseded: false,
			pinned: !!params.pinned,
			parent_memory_id: parentMemoryId,
			access_count: 0,
			last_accessed_at: null,
		}
	}

	mergeDuplicateMemory(params: {
		id: string
		memoryTypeOverride?: MemoryType
		pinnedOverride?: boolean
		expiresAtOverride?: number | null
	}): MemoryRow | null {
		const existing = this.getMemory(params.id)
		if (!existing) return null

		const nextMemoryType = params.memoryTypeOverride ?? existing.memory_type
		const nextPinned = existing.pinned || params.pinnedOverride === true
		const nextExpiresAt =
			params.expiresAtOverride !== undefined
				? params.expiresAtOverride
				: existing.expires_at

		const now = Date.now()
		this.db
			.prepare(
				`UPDATE memories
         SET memory_type = ?,
             pinned = ?,
             expires_at = ?,
             updated_at = ?,
             access_count = access_count + 1,
             last_accessed_at = ?
         WHERE id = ?`,
			)
			.run(
				nextMemoryType,
				nextPinned ? 1 : 0,
				nextExpiresAt,
				now,
				now,
				params.id,
			)

		return this.getMemory(params.id)
	}

	getMemory(id: string): MemoryRow | null {
		const row = this.db
			.prepare("SELECT * FROM memories WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined
		return row ? this.rowToMemory(row) : null
	}

	getMemoriesByIds(ids: string[]): MemoryRow[] {
		if (ids.length === 0) return []
		const placeholders = ids.map(() => "?").join(", ")
		const rows = this.db
			.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
			.all(...ids) as Record<string, unknown>[]
		const byId = new Map(
			rows.map((row) => [row.id as string, this.rowToMemory(row)]),
		)
		return ids
			.map((id) => byId.get(id))
			.filter((row): row is MemoryRow => !!row)
	}

	findExactMemory(text: string): MemoryRow | null {
		const row = this.db
			.prepare(
				`SELECT * FROM memories
         WHERE is_superseded = 0
           AND lower(trim(text)) = lower(trim(?))
         ORDER BY created_at DESC
         LIMIT 1`,
			)
			.get(text) as Record<string, unknown> | undefined

		return row ? this.rowToMemory(row) : null
	}

	deleteMemory(id: string): boolean {
		const uuidRegex =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
		if (!uuidRegex.test(id)) {
			throw new Error(`Invalid memory ID format: ${id}`)
		}
		if (this.vecAvailable) {
			this.db.prepare("DELETE FROM memories_vec WHERE id = ?").run(id)
		}
		const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id)
		return (result as { changes?: number }).changes !== 0
	}

	markSuperseded(id: string): void {
		this.db
			.prepare(
				"UPDATE memories SET is_superseded = 1, updated_at = ? WHERE id = ?",
			)
			.run(Date.now(), id)
	}

	setParentMemoryId(id: string, parentId: string): void {
		this.db
			.prepare(
				"UPDATE memories SET parent_memory_id = ?, updated_at = ? WHERE id = ?",
			)
			.run(parentId, Date.now(), id)
	}

	bumpAccessCount(id: string): void {
		const now = Date.now()
		this.db
			.prepare(
				"UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?",
			)
			.run(now, id)
	}

	countMemories(): number {
		const row = this.db
			.prepare("SELECT COUNT(*) as cnt FROM memories WHERE is_superseded = 0")
			.get() as { cnt: number }
		return row.cnt
	}

	listActiveMemories(limit = 100, offset = 0): MemoryRow[] {
		const sql = `SELECT * FROM memories WHERE is_superseded = 0
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
		const rows = this.db.prepare(sql).all(limit, offset) as Record<
			string,
			unknown
		>[]
		return rows.map((row) => this.rowToMemory(row))
	}

	countActiveMemoriesMissingVectors(): number {
		const row = this.db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memories WHERE is_superseded = 0 AND vector IS NULL",
			)
			.get() as { cnt: number }
		return row.cnt
	}

	listActiveMemoriesMissingVectors(
		limit: number,
	): Array<{ id: string; text: string }> {
		return this.db
			.prepare(
				`SELECT id, text FROM memories
         WHERE is_superseded = 0 AND vector IS NULL
         ORDER BY created_at ASC
         LIMIT ?`,
			)
			.all(limit) as Array<{ id: string; text: string }>
	}

	countActiveIndexedMemories(): number {
		if (!this.vecAvailable) return 0

		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt
         FROM memories m
         JOIN memories_vec v ON v.id = m.id
         WHERE m.is_superseded = 0`,
			)
			.get() as { cnt: number }
		return row.cnt
	}

	countActiveMemoriesMissingVectorIndex(): number {
		if (!this.vecAvailable) return 0

		const row = this.db
			.prepare(
				`SELECT COUNT(*) as cnt
         FROM memories m
         LEFT JOIN memories_vec v ON v.id = m.id
         WHERE m.is_superseded = 0
           AND m.vector IS NOT NULL
           AND v.id IS NULL`,
			)
			.get() as { cnt: number }
		return row.cnt
	}

	listActiveMemoriesMissingVectorIndex(
		limit: number,
	): Array<{ id: string; vector: Float64Array }> {
		if (!this.vecAvailable) return []

		const rows = this.db
			.prepare(
				`SELECT m.id, m.vector
         FROM memories m
         LEFT JOIN memories_vec v ON v.id = m.id
         WHERE m.is_superseded = 0
           AND m.vector IS NOT NULL
           AND v.id IS NULL
         ORDER BY m.created_at ASC
         LIMIT ?`,
			)
			.all(limit) as Array<{ id: string; vector: Buffer | Uint8Array }>

		return rows.map((row) => ({
			id: row.id,
			vector: blobToFloat64(row.vector),
		}))
	}

	upsertMemoryVector(id: string, vector: Float64Array): void {
		this.db
			.prepare("UPDATE memories SET vector = ? WHERE id = ?")
			.run(float64ToBlob(vector), id)
		this.upsertVectorIndex(id, vector)
	}

	upsertMemoryVectorIndex(id: string, vector: Float64Array): void {
		this.upsertVectorIndex(id, vector)
	}

	getVectorBackfillStats(): VectorBackfillStats {
		const missingVectors = this.countActiveMemoriesMissingVectors()
		const missingIndexRows = this.countActiveMemoriesMissingVectorIndex()
		return {
			indexed: this.countActiveIndexedMemories(),
			missingVectors,
			missingIndexRows,
			pendingBackfill: missingVectors + missingIndexRows,
		}
	}

	vectorSearch(
		queryVector: Float64Array,
		limit: number,
		minScore: number,
	): Array<{ id: string; score: number }> {
		if (!this.vecAvailable) return []

		const vectorBlob = float64ToBlob(queryVector)
		const rows = this.db
			.prepare(
				"SELECT id, distance FROM memories_vec WHERE vector MATCH ? ORDER BY distance LIMIT ?",
			)
			.all(vectorBlob, limit * 4) as Array<{ id: string; distance: number }>

		const supersededIds = this.getSupersededIds()
		return rows
			.filter((row) => !supersededIds.has(row.id))
			.map((row) => ({
				id: row.id,
				score: 1 - row.distance,
			}))
			.filter((row) => row.score >= minScore)
	}

	private getSupersededIds(): Set<string> {
		const rows = this.db
			.prepare("SELECT id FROM memories WHERE is_superseded = 1")
			.all() as Array<{ id: string }>
		return new Set(rows.map((row) => row.id))
	}

	ftsSearch(
		query: string,
		limit: number,
	): Array<{ id: string; score: number }> {
		const sanitized = query.replace(/['"]/g, "").trim()
		if (!sanitized) return []
		const terms = sanitized.split(/\s+/).filter(Boolean)
		if (terms.length === 0) return []
		const ftsQuery = terms.map((term) => `"${term}"`).join(" OR ")

		try {
			const rows = this.db
				.prepare(
					`SELECT f.id, f.rank FROM memories_fts f
           JOIN memories m ON m.id = f.id
           WHERE memories_fts MATCH ? AND m.is_superseded = 0
           ORDER BY f.rank LIMIT ?`,
				)
				.all(ftsQuery, limit) as Array<{ id: string; rank: number }>

			if (rows.length === 0) return []
			const maxAbsRank = Math.max(...rows.map((row) => Math.abs(row.rank)))
			return rows.map((row) => ({
				id: row.id,
				score: maxAbsRank > 0 ? Math.abs(row.rank) / maxAbsRank : 0.5,
			}))
		} catch {
			return []
		}
	}

	resolveEntityAlias(
		surfaceText: string,
		normalizedText: string,
		kind?: string | null,
	): {
		entity: EntityRow
		alias: EntityAliasRow
	} {
		const now = Date.now()
		const existing = this.db
			.prepare(
				`SELECT
           a.*,
           e.canonical_name,
           e.kind as entity_kind,
           e.first_seen as entity_first_seen,
           e.last_seen as entity_last_seen,
           e.merged_into_id
         FROM entity_aliases a
         JOIN entities e ON e.id = a.entity_id
         WHERE a.normalized_text = ? AND e.merged_into_id IS NULL
         LIMIT 1`,
			)
			.get(normalizedText) as Record<string, unknown> | undefined

		if (existing) {
			const aliasKind = (existing.kind as string | null) ?? kind ?? null
			const entityKind = (existing.entity_kind as string | null) ?? kind ?? null
			this.db
				.prepare(
					"UPDATE entity_aliases SET last_seen = ?, kind = COALESCE(kind, ?) WHERE id = ?",
				)
				.run(now, kind ?? null, existing.id as string)
			this.db
				.prepare(
					"UPDATE entities SET last_seen = ?, kind = COALESCE(kind, ?) WHERE id = ?",
				)
				.run(now, kind ?? null, existing.entity_id as string)

			return {
				entity: {
					id: existing.entity_id as string,
					canonical_name: existing.canonical_name as string,
					kind: entityKind,
					first_seen: existing.entity_first_seen as number,
					last_seen: now,
					merged_into_id: (existing.merged_into_id as string | null) ?? null,
				},
				alias: {
					id: existing.id as string,
					entity_id: existing.entity_id as string,
					surface_text: existing.surface_text as string,
					normalized_text: existing.normalized_text as string,
					kind: aliasKind,
					first_seen: existing.first_seen as number,
					last_seen: now,
				},
			}
		}

		const entityId = randomUUID()
		const aliasId = randomUUID()
		const safeKind = kind ?? null

		this.db
			.prepare(
				`INSERT INTO entities (id, canonical_name, kind, first_seen, last_seen, merged_into_id)
         VALUES (?, ?, ?, ?, ?, NULL)`,
			)
			.run(entityId, surfaceText, safeKind, now, now)

		this.db
			.prepare(
				`INSERT INTO entity_aliases (
           id,
           entity_id,
           surface_text,
           normalized_text,
           kind,
           first_seen,
           last_seen
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(aliasId, entityId, surfaceText, normalizedText, safeKind, now, now)

		return {
			entity: {
				id: entityId,
				canonical_name: surfaceText,
				kind: safeKind,
				first_seen: now,
				last_seen: now,
				merged_into_id: null,
			},
			alias: {
				id: aliasId,
				entity_id: entityId,
				surface_text: surfaceText,
				normalized_text: normalizedText,
				kind: safeKind,
				first_seen: now,
				last_seen: now,
			},
		}
	}

	linkAliasToMemory(memoryId: string, aliasId: string): void {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO entity_mentions (memory_id, alias_id) VALUES (?, ?)",
			)
			.run(memoryId, aliasId)
	}

	getEntityMentionsForMemory(memoryId: string): MemoryEntityMentionRow[] {
		return this.db
			.prepare(
				`SELECT
           a.id as alias_id,
           e.id as entity_id,
           a.surface_text,
           a.normalized_text,
           a.kind as alias_kind,
           e.canonical_name,
           e.kind as canonical_kind
         FROM entity_mentions em
         JOIN entity_aliases a ON a.id = em.alias_id
         JOIN entities e ON e.id = a.entity_id
         WHERE em.memory_id = ? AND e.merged_into_id IS NULL
         ORDER BY a.surface_text COLLATE NOCASE`,
			)
			.all(memoryId) as MemoryEntityMentionRow[]
	}

	getCanonicalEntityIdsForMemory(memoryId: string): string[] {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT e.id as id
         FROM entity_mentions em
         JOIN entity_aliases a ON a.id = em.alias_id
         JOIN entities e ON e.id = a.entity_id
         WHERE em.memory_id = ? AND e.merged_into_id IS NULL`,
			)
			.all(memoryId) as Array<{ id: string }>
		return rows.map((row) => row.id)
	}

	getMemoriesForEntity(entityId: string): MemoryRow[] {
		const rows = this.db
			.prepare(
				`SELECT DISTINCT m.* FROM memories m
         JOIN entity_mentions em ON em.memory_id = m.id
         JOIN entity_aliases a ON a.id = em.alias_id
         WHERE a.entity_id = ? AND m.is_superseded = 0
         ORDER BY m.created_at DESC`,
			)
			.all(entityId) as Record<string, unknown>[]
		return rows.map((row) => this.rowToMemory(row))
	}

	listCanonicalEntities(limit = 200): EntityRow[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM entities
         WHERE merged_into_id IS NULL
         ORDER BY last_seen DESC
         LIMIT ?`,
			)
			.all(limit) as Record<string, unknown>[]
		return rows.map((row) => this.rowToEntity(row))
	}

	getAliasesForEntity(entityId: string): EntityAliasRow[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM entity_aliases
         WHERE entity_id = ?
         ORDER BY last_seen DESC, surface_text COLLATE NOCASE`,
			)
			.all(entityId) as Record<string, unknown>[]
		return rows.map((row) => this.rowToEntityAlias(row))
	}

	mergeEntities(survivorId: string, loserId: string): boolean {
		if (survivorId === loserId) return false

		const survivor = this.getCanonicalEntity(survivorId)
		const loser = this.getCanonicalEntity(loserId)
		if (!survivor || !loser) return false

		const lastSeen = Math.max(survivor.last_seen, loser.last_seen)
		this.db
			.prepare("UPDATE entity_aliases SET entity_id = ? WHERE entity_id = ?")
			.run(survivorId, loserId)
		this.db
			.prepare(
				"UPDATE entities SET last_seen = ?, kind = COALESCE(kind, ?) WHERE id = ?",
			)
			.run(lastSeen, loser.kind ?? null, survivorId)
		this.db
			.prepare(
				"UPDATE entities SET merged_into_id = ?, last_seen = ? WHERE id = ?",
			)
			.run(survivorId, lastSeen, loserId)
		return true
	}

	getCanonicalEntity(id: string): EntityRow | null {
		const row = this.db
			.prepare("SELECT * FROM entities WHERE id = ?")
			.get(id) as Record<string, unknown> | undefined
		return row ? this.rowToEntity(row) : null
	}

	addRelationship(
		sourceId: string,
		targetId: string,
		relationType: RelationType,
	): RelationshipRow {
		const existing = this.db
			.prepare(
				`SELECT * FROM relationships
         WHERE source_id = ? AND target_id = ? AND relation_type = ?
         LIMIT 1`,
			)
			.get(sourceId, targetId, relationType) as
			| Record<string, unknown>
			| undefined

		if (existing) {
			return this.rowToRelationship(existing)
		}

		const id = randomUUID()
		const now = Date.now()
		this.db
			.prepare(
				`INSERT INTO relationships (id, source_id, target_id, relation_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
			)
			.run(id, sourceId, targetId, relationType, now)

		if (relationType === "updates") {
			this.markSuperseded(targetId)
		}

		return {
			id,
			source_id: sourceId,
			target_id: targetId,
			relation_type: relationType,
			created_at: now,
		}
	}

	getRelationshipsForMemory(memoryId: string): RelationshipRow[] {
		return this.db
			.prepare(
				"SELECT * FROM relationships WHERE source_id = ? OR target_id = ? ORDER BY created_at DESC",
			)
			.all(memoryId, memoryId)
			.map((row) => this.rowToRelationship(row as Record<string, unknown>))
	}

	getRelatedMemoryIds(memoryId: string, maxHops = 2): Set<string> {
		const visited = new Set<string>()
		const queue: Array<{ id: string; depth: number }> = [
			{ id: memoryId, depth: 0 },
		]

		while (queue.length > 0) {
			const current = queue.shift()!
			if (visited.has(current.id) || current.depth > maxHops) continue
			visited.add(current.id)

			const rels = this.db
				.prepare(
					"SELECT source_id, target_id FROM relationships WHERE source_id = ? OR target_id = ?",
				)
				.all(current.id, current.id) as Array<{
				source_id: string
				target_id: string
			}>

			for (const rel of rels) {
				const next =
					rel.source_id === current.id ? rel.target_id : rel.source_id
				if (!visited.has(next)) {
					queue.push({ id: next, depth: current.depth + 1 })
				}
			}
		}

		visited.delete(memoryId)
		return visited
	}

	getProfileCache(profileType: "longTerm" | "recent"): ProfileCacheRow | null {
		const row = this.db
			.prepare("SELECT * FROM profile_cache WHERE profile_type = ?")
			.get(profileType) as ProfileCacheRow | undefined
		return row ?? null
	}

	setProfileCache(profileType: "longTerm" | "recent", content: string[]): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO profile_cache (profile_type, content, updated_at) VALUES (?, ?, ?)",
			)
			.run(profileType, JSON.stringify(content), Date.now())
	}

	getCachedEmbedding(hash: string): Float64Array | null {
		const row = this.db
			.prepare("SELECT vector FROM embedding_cache WHERE hash = ?")
			.get(hash) as { vector: Buffer } | undefined
		return row ? blobToFloat64(row.vector) : null
	}

	setCachedEmbedding(hash: string, vector: Float64Array): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO embedding_cache (hash, vector, created_at) VALUES (?, ?, ?)",
			)
			.run(hash, float64ToBlob(vector), Date.now())
	}

	deleteExpiredMemories(): number {
		const now = Date.now()
		const expired = this.db
			.prepare(
				"SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?",
			)
			.all(now) as Array<{ id: string }>
		for (const row of expired) {
			this.deleteMemory(row.id)
		}
		return expired.length
	}

	deleteDecayedMemories(decayDays: number): number {
		const cutoff = Date.now() - decayDays * 24 * 60 * 60 * 1000
		const candidates = this.db
			.prepare(
				`SELECT id FROM memories
         WHERE memory_type = 'episode'
           AND access_count = 0
           AND created_at < ?
           AND is_superseded = 0
           AND pinned = 0`,
			)
			.all(cutoff) as Array<{ id: string }>

		for (const row of candidates) {
			this.deleteMemory(row.id)
		}
		return candidates.length
	}

	wipeAll(): void {
		this.db.exec("DELETE FROM relationships")
		this.db.exec("DELETE FROM entity_mentions")
		this.db.exec("DELETE FROM entity_aliases")
		this.db.exec("DELETE FROM entities")
		this.db.exec("DELETE FROM embedding_cache")
		this.db.exec("DELETE FROM profile_cache")
		if (this.vecAvailable) {
			this.db.exec("DELETE FROM memories_vec")
		}
		this.db.exec("DELETE FROM memories")
	}

	close(): void {
		try {
			this.db.close()
		} catch {}
	}

	stats(): {
		totalMemories: number
		activeMemories: number
		supersededMemories: number
		entities: number
		relationships: number
	} {
		const total = (
			this.db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as {
				cnt: number
			}
		).cnt
		const active = (
			this.db
				.prepare("SELECT COUNT(*) as cnt FROM memories WHERE is_superseded = 0")
				.get() as { cnt: number }
		).cnt
		const entities = (
			this.db
				.prepare(
					"SELECT COUNT(*) as cnt FROM entities WHERE merged_into_id IS NULL",
				)
				.get() as { cnt: number }
		).cnt
		const relationships = (
			this.db.prepare("SELECT COUNT(*) as cnt FROM relationships").get() as {
				cnt: number
			}
		).cnt

		return {
			totalMemories: total,
			activeMemories: active,
			supersededMemories: total - active,
			entities,
			relationships,
		}
	}

	private rowToMemory(row: Record<string, unknown>): MemoryRow {
		return {
			id: row.id as string,
			text: row.text as string,
			vector: row.vector ? blobToFloat64(row.vector as Buffer) : null,
			memory_type: row.memory_type as MemoryType,
			created_at: row.created_at as number,
			updated_at: row.updated_at as number,
			expires_at: (row.expires_at as number | null) ?? null,
			is_superseded: !!(row.is_superseded as number),
			pinned: !!(row.pinned as number),
			parent_memory_id: (row.parent_memory_id as string | null) ?? null,
			access_count: row.access_count as number,
			last_accessed_at: (row.last_accessed_at as number | null) ?? null,
		}
	}

	private rowToEntity(row: Record<string, unknown>): EntityRow {
		return {
			id: row.id as string,
			canonical_name: row.canonical_name as string,
			kind: (row.kind as string | null) ?? null,
			first_seen: row.first_seen as number,
			last_seen: row.last_seen as number,
			merged_into_id: (row.merged_into_id as string | null) ?? null,
		}
	}

	private rowToEntityAlias(row: Record<string, unknown>): EntityAliasRow {
		return {
			id: row.id as string,
			entity_id: row.entity_id as string,
			surface_text: row.surface_text as string,
			normalized_text: row.normalized_text as string,
			kind: (row.kind as string | null) ?? null,
			first_seen: row.first_seen as number,
			last_seen: row.last_seen as number,
		}
	}

	private rowToRelationship(row: Record<string, unknown>): RelationshipRow {
		return {
			id: row.id as string,
			source_id: row.source_id as string,
			target_id: row.target_id as string,
			relation_type: row.relation_type as RelationType,
			created_at: row.created_at as number,
		}
	}
}
