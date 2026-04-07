import type { SupermemoryConfig } from "./config.ts"
import type { MemoryDB } from "./db.ts"
import type { EmbeddingProvider } from "./embeddings.ts"
import {
	resolveEntityEquivalences,
	type SemanticLogLike,
	type SemanticRuntimeLike,
} from "./fact-extractor.ts"
import {
	buildEntityMergeCandidates,
	formatEntityMergeInputs,
} from "./graph-engine.ts"

export type ForgetResult = {
	expiredCount: number
	decayedCount: number
	totalRemoved: number
}

const ENTITY_MERGE_ENTITY_LIMIT = 120
const ENTITY_MERGE_PAIR_LIMIT = 24
const VECTOR_BACKFILL_BATCH_SIZE = 20
const VECTOR_BACKFILL_INTERVAL_MS = 1000
const ENTITY_MERGE_SCOPE_KEY = "maintenance"

export function runForgettingCycle(
	db: MemoryDB,
	cfg: SupermemoryConfig,
): ForgetResult {
	const expiredCount = db.deleteExpiredMemories()
	const decayedCount = db.deleteDecayedMemories(cfg.temporalDecayDays)

	return {
		expiredCount,
		decayedCount,
		totalRemoved: expiredCount + decayedCount,
	}
}

export async function runEntityMergeCycle(
	db: MemoryDB,
	cfg: SupermemoryConfig,
	embeddings: EmbeddingProvider,
	semanticRuntime: SemanticRuntimeLike | null,
	log: SemanticLogLike,
): Promise<number> {
	if (!semanticRuntime) return 0

	const entities = formatEntityMergeInputs(db, ENTITY_MERGE_ENTITY_LIMIT)
	if (entities.length < 2) return 0
	log.debug?.(`entity merge cycle start (${entities.length} entities)`)

	const vectors = cfg.embedding.enabled
		? await embeddings.embedBatch(
				entities.map((entity) => entity.canonicalName),
			)
		: entities.map(() => new Float64Array(embeddings.dimensions))

	const embeddingsByEntityId = new Map(
		entities.map((entity, index) => [entity.id, vectors[index]]),
	)

	const candidatePairs = buildEntityMergeCandidates(
		entities,
		embeddingsByEntityId,
	).slice(0, ENTITY_MERGE_PAIR_LIMIT)
	if (candidatePairs.length === 0) {
		log.debug?.("entity merge cycle → no candidate pairs found")
		return 0
	}
	log.debug?.(
		`entity merge cycle → ${candidatePairs.length} candidate pairs, resolving…`,
	)

	const decisions = await resolveEntityEquivalences(
		candidatePairs,
		semanticRuntime,
		log,
		{
			semanticScope: {
				scopeKey: ENTITY_MERGE_SCOPE_KEY,
			},
		},
	)
	let mergedCount = 0

	for (const decision of decisions) {
		if (decision.decision !== "same") continue

		const left = db.getCanonicalEntity(decision.leftEntityId)
		const right = db.getCanonicalEntity(decision.rightEntityId)
		if (!left || !right) continue

		const survivor = left.first_seen <= right.first_seen ? left : right
		const loser = survivor.id === left.id ? right : left

		if (db.mergeEntities(survivor.id, loser.id)) {
			mergedCount++
		}
	}

	if (mergedCount > 0) {
		log.debug?.(`entity merge cycle → merged ${mergedCount} entity pairs`)
	}
	return mergedCount
}

export class ForgettingService {
	private maintenanceTimer: ReturnType<typeof setInterval> | null = null
	private backfillTimer: ReturnType<typeof setTimeout> | null = null
	private readonly intervalMs: number
	private maintenanceInFlight = false
	private backfillInFlight = false

	constructor(
		private readonly db: MemoryDB,
		private readonly cfg: SupermemoryConfig,
		private readonly log: SemanticLogLike,
		private readonly options?: {
			embeddings?: EmbeddingProvider
			semanticRuntime?: SemanticRuntimeLike | null
		},
	) {
		this.intervalMs = cfg.forgetExpiredIntervalMinutes * 60 * 1000
	}

	start(): void {
		if (this.maintenanceTimer) return

		void this.runMaintenanceCycle()
		this.maintenanceTimer = setInterval(() => {
			void this.runMaintenanceCycle()
		}, this.intervalMs)
		this.scheduleVectorBackfill(0)
	}

	stop(): void {
		if (this.maintenanceTimer) {
			clearInterval(this.maintenanceTimer)
			this.maintenanceTimer = null
		}
		if (this.backfillTimer) {
			clearTimeout(this.backfillTimer)
			this.backfillTimer = null
		}
	}

	private scheduleVectorBackfill(delayMs = VECTOR_BACKFILL_INTERVAL_MS): void {
		if (this.backfillTimer) return
		if (!this.cfg.embedding.enabled || !this.options?.embeddings) return

		this.backfillTimer = setTimeout(() => {
			this.backfillTimer = null
			void this.runVectorBackfillCycle()
		}, delayMs)
	}

	private async runVectorBackfillCycle(): Promise<void> {
		if (this.backfillInFlight) return
		if (!this.cfg.embedding.enabled || !this.options?.embeddings) return

		this.backfillInFlight = true
		let shouldReschedule = false

		try {
			let reindexed = 0
			if (this.db.isVectorAvailable) {
				const missingIndexRows = this.db.listActiveMemoriesMissingVectorIndex(
					VECTOR_BACKFILL_BATCH_SIZE,
				)
				for (const row of missingIndexRows) {
					this.db.upsertMemoryVectorIndex(row.id, row.vector)
					reindexed++
				}
			}

			let embedded = 0
			const missingVectors = this.db.listActiveMemoriesMissingVectors(
				VECTOR_BACKFILL_BATCH_SIZE,
			)
			if (missingVectors.length > 0) {
				const vectors = await this.options.embeddings.embedBatch(
					missingVectors.map((memory) => memory.text),
				)
				for (let index = 0; index < missingVectors.length; index++) {
					this.db.upsertMemoryVector(missingVectors[index].id, vectors[index])
					embedded++
				}
			}

			const stats = this.db.getVectorBackfillStats()
			shouldReschedule = stats.pendingBackfill > 0

			if (reindexed > 0 || embedded > 0) {
				this.log.info(
					"vector backfill progressed " +
						`(${reindexed} reindexed, ${embedded} embedded, ${stats.pendingBackfill} remaining)`,
				)
			}
		} catch (err) {
			shouldReschedule = true
			this.log.warn(`vector backfill failed: ${String(err)}`)
		} finally {
			this.backfillInFlight = false
			if (shouldReschedule) {
				this.scheduleVectorBackfill()
			}
		}
	}

	private async runMaintenanceCycle(): Promise<void> {
		if (this.maintenanceInFlight) return

		this.maintenanceInFlight = true
		this.log.debug?.("maintenance cycle start")
		try {
			const forgetting = runForgettingCycle(this.db, this.cfg)
			const mergedCount = this.options?.embeddings
				? await runEntityMergeCycle(
						this.db,
						this.cfg,
						this.options.embeddings,
						this.options.semanticRuntime ?? null,
						this.log,
					)
				: 0

			if (forgetting.totalRemoved > 0 || mergedCount > 0) {
				const parts: string[] = []
				if (forgetting.totalRemoved > 0) {
					parts.push(
						`${forgetting.totalRemoved} memories removed (${forgetting.expiredCount} expired, ${forgetting.decayedCount} decayed)`,
					)
				}
				if (mergedCount > 0) {
					parts.push(`${mergedCount} entity merges`)
				}
				this.log.info(`maintenance cycle completed: ${parts.join(", ")}`)
			}
		} catch (err) {
			this.log.warn(`maintenance cycle failed: ${String(err)}`)
		} finally {
			this.maintenanceInFlight = false
		}
	}
}
