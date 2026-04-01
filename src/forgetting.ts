import type { SupermemoryConfig } from "./config.ts";
import type { MemoryDB } from "./db.ts";
import type { EmbeddingProvider } from "./embeddings.ts";
import {
  resolveEntityEquivalences,
  type SemanticLogLike,
  type SemanticRuntimeLike,
} from "./fact-extractor.ts";
import { buildEntityMergeCandidates, formatEntityMergeInputs } from "./graph-engine.ts";

export type ForgetResult = {
  expiredCount: number;
  decayedCount: number;
  totalRemoved: number;
};

const ENTITY_MERGE_ENTITY_LIMIT = 120;
const ENTITY_MERGE_PAIR_LIMIT = 24;

export function runForgettingCycle(db: MemoryDB, cfg: SupermemoryConfig): ForgetResult {
  const expiredCount = db.deleteExpiredMemories();
  const decayedCount = db.deleteDecayedMemories(cfg.temporalDecayDays);

  return {
    expiredCount,
    decayedCount,
    totalRemoved: expiredCount + decayedCount,
  };
}

export async function runEntityMergeCycle(
  db: MemoryDB,
  embeddings: EmbeddingProvider,
  semanticRuntime: SemanticRuntimeLike | null,
  log: SemanticLogLike,
): Promise<number> {
  if (!semanticRuntime) return 0;

  const entities = formatEntityMergeInputs(db, ENTITY_MERGE_ENTITY_LIMIT);
  if (entities.length < 2) return 0;

  const vectors = await embeddings.embedBatch(entities.map((entity) => entity.canonicalName));
  const embeddingsByEntityId = new Map(
    entities.map((entity, index) => [entity.id, vectors[index]]),
  );

  const candidatePairs = buildEntityMergeCandidates(entities, embeddingsByEntityId).slice(
    0,
    ENTITY_MERGE_PAIR_LIMIT,
  );
  if (candidatePairs.length === 0) return 0;

  const decisions = await resolveEntityEquivalences(candidatePairs, semanticRuntime, log);
  let mergedCount = 0;

  for (const decision of decisions) {
    if (decision.decision !== "same") continue;

    const left = db.getCanonicalEntity(decision.leftEntityId);
    const right = db.getCanonicalEntity(decision.rightEntityId);
    if (!left || !right) continue;

    const survivor = left.first_seen <= right.first_seen ? left : right;
    const loser = survivor.id === left.id ? right : left;

    if (db.mergeEntities(survivor.id, loser.id)) {
      mergedCount++;
    }
  }

  return mergedCount;
}

export class ForgettingService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly db: MemoryDB,
    private readonly cfg: SupermemoryConfig,
    private readonly log: SemanticLogLike,
    private readonly options?: {
      embeddings?: EmbeddingProvider;
      semanticRuntime?: SemanticRuntimeLike | null;
    },
  ) {
    this.intervalMs = cfg.forgetExpiredIntervalMinutes * 60 * 1000;
  }

  start(): void {
    if (this.timer) return;

    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runCycle(): Promise<void> {
    try {
      const forgetting = runForgettingCycle(this.db, this.cfg);
      const mergedCount =
        this.options?.embeddings
          ? await runEntityMergeCycle(
              this.db,
              this.options.embeddings,
              this.options.semanticRuntime ?? null,
              this.log,
            )
          : 0;

      if (forgetting.totalRemoved > 0 || mergedCount > 0) {
        const parts: string[] = [];
        if (forgetting.totalRemoved > 0) {
          parts.push(
            `${forgetting.totalRemoved} memories removed (${forgetting.expiredCount} expired, ${forgetting.decayedCount} decayed)`,
          );
        }
        if (mergedCount > 0) {
          parts.push(`${mergedCount} entity merges`);
        }
        this.log.info(`memory-supermemory: maintenance cycle completed: ${parts.join(", ")}`);
      }
    } catch (err) {
      this.log.warn(`memory-supermemory: maintenance cycle failed: ${String(err)}`);
    }
  }
}
