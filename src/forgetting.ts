import type { SupermemoryConfig } from "./config.ts";
import type { MemoryDB } from "./db.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForgetResult = {
  expiredCount: number;
  decayedCount: number;
  totalRemoved: number;
};

// ---------------------------------------------------------------------------
// Forgetting engine
// ---------------------------------------------------------------------------

export function runForgettingCycle(db: MemoryDB, cfg: SupermemoryConfig): ForgetResult {
  // 1. Remove expired memories (time-bound facts like "meeting tomorrow")
  const expiredCount = db.deleteExpiredMemories();

  // 2. Decay low-importance, never-accessed memories older than the decay window
  const decayedCount = db.deleteDecayedMemories(cfg.temporalDecayDays, 0.3);

  return {
    expiredCount,
    decayedCount,
    totalRemoved: expiredCount + decayedCount,
  };
}

// ---------------------------------------------------------------------------
// Background forgetting service
// ---------------------------------------------------------------------------

export class ForgettingService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly db: MemoryDB,
    private readonly cfg: SupermemoryConfig,
    private readonly log: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {
    this.intervalMs = cfg.forgetExpiredIntervalMinutes * 60 * 1000;
  }

  start(): void {
    if (this.timer) return;

    // Run once immediately
    this.runCycle();

    // Then on interval
    this.timer = setInterval(() => {
      this.runCycle();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private runCycle(): void {
    try {
      const result = runForgettingCycle(this.db, this.cfg);
      if (result.totalRemoved > 0) {
        this.log.info(
          `memory-supermemory: forgetting cycle removed ${result.totalRemoved} memories ` +
            `(${result.expiredCount} expired, ${result.decayedCount} decayed)`,
        );
      }
    } catch (err) {
      this.log.warn(`memory-supermemory: forgetting cycle failed: ${String(err)}`);
    }
  }
}
