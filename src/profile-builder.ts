import type { SupermemoryConfig } from "./config.ts";
import type { MemoryDB, MemoryRow } from "./db.ts";
import type { SemanticLogger } from "./semantic-runtime.ts";
import {
  dedupeMemoryTexts,
  normalizeMemoryText,
  sanitizeMemoryTextForPrompt,
  isSyntheticMemoryText,
} from "./memory-text.ts";

export type UserProfile = {
  longTerm: string[];
  recent: string[];
  updatedAt: number;
};

const PROFILE_REBUILD_MAX_AGE_MS = 60 * 60 * 1000;

export function buildUserProfile(db: MemoryDB, cfg: SupermemoryConfig, log?: SemanticLogger): UserProfile {
  const now = Date.now();
  const recentWindowMs = cfg.recentWindowDays * 24 * 60 * 60 * 1000;
  const allActive = prioritizePinned(db.listActiveMemories(cfg.profileScanLimit));

  const longTerm: string[] = [];
  const recent: string[] = [];
  const seen = new Set<string>();

  for (const memory of allActive) {
    if (isSyntheticMemoryText(memory.text)) continue;
    const normalized = normalizeMemoryText(memory.text);
    if (!normalized || seen.has(normalized)) continue;

    const displayText = sanitizeMemoryTextForPrompt(memory.text, cfg.promptMemoryMaxChars);
    if (!displayText) continue;

    const isPinned = memory.pinned;
    const qualifiesForLongTerm =
      isPinned ||
      memory.memory_type === "fact" ||
      memory.memory_type === "preference";

    if (qualifiesForLongTerm && longTerm.length < cfg.maxLongTermItems) {
      longTerm.push(displayText);
      seen.add(normalized);
      continue;
    }

    const isRecent = now - memory.created_at < recentWindowMs;
    const qualifiesForRecent = memory.memory_type === "episode" && isRecent;

    if (qualifiesForRecent && recent.length < cfg.maxRecentItems) {
      recent.push(displayText);
      seen.add(normalized);
    }
  }

  db.setProfileCache("longTerm", longTerm);
  db.setProfileCache("recent", recent);

  log?.debug?.(`profile built (lt=${longTerm.length}, recent=${recent.length}) from ${allActive.length} active memories`);
  return { longTerm, recent, updatedAt: now };
}

export function getCachedProfile(db: MemoryDB, cfg: SupermemoryConfig): UserProfile | null {
  const longTermCache = db.getProfileCache("longTerm");
  const recentCache = db.getProfileCache("recent");

  if (!longTermCache || !recentCache) return null;

  const longTerm = dedupeMemoryTexts(JSON.parse(longTermCache.content) as string[])
    .map((item) => sanitizeMemoryTextForPrompt(item, cfg.promptMemoryMaxChars))
    .filter(Boolean);
  const recent = dedupeMemoryTexts(JSON.parse(recentCache.content) as string[])
    .map((item) => sanitizeMemoryTextForPrompt(item, cfg.promptMemoryMaxChars))
    .filter(Boolean);

  return {
    longTerm,
    recent,
    updatedAt: Math.max(longTermCache.updated_at, recentCache.updated_at),
  };
}

export function shouldRebuildProfile(
  db: MemoryDB,
  cfg: SupermemoryConfig,
  interactionCount: number,
  log?: SemanticLogger,
): boolean {
  const cached = getCachedProfile(db, cfg);
  if (!cached) {
    log?.debug?.("profile rebuild triggered (no cache)");
    return true;
  }

  if (interactionCount > 0 && interactionCount % cfg.profileFrequency === 0) {
    log?.debug?.(`profile rebuild triggered (frequency hit at interaction=${interactionCount})`);
    return true;
  }
  const ageMs = Date.now() - cached.updatedAt;
  if (ageMs > PROFILE_REBUILD_MAX_AGE_MS) {
    log?.debug?.(`profile rebuild triggered (stale, age=${Math.round(ageMs / 1000)}s)`);
    return true;
  }

  log?.debug?.(`profile cache hit (age=${Math.round(ageMs / 1000)}s, lt=${cached.longTerm.length}, recent=${cached.recent.length})`);
  return false;
}

export function getOrBuildProfile(
  db: MemoryDB,
  cfg: SupermemoryConfig,
  interactionCount: number,
  log?: SemanticLogger,
): UserProfile {
  if (shouldRebuildProfile(db, cfg, interactionCount, log)) {
    return buildUserProfile(db, cfg, log);
  }
  return getCachedProfile(db, cfg) ?? buildUserProfile(db, cfg, log);
}

export function formatProfileForPrompt(
  profile: UserProfile,
  cfg: SupermemoryConfig,
): string {
  const longTerm = dedupeMemoryTexts(profile.longTerm)
    .map((item) => sanitizeMemoryTextForPrompt(item, cfg.promptMemoryMaxChars))
    .filter(Boolean);
  const recent = dedupeMemoryTexts(profile.recent)
    .map((item) => sanitizeMemoryTextForPrompt(item, cfg.promptMemoryMaxChars))
    .filter(Boolean);

  const lines: string[] = [];

  if (longTerm.length > 0) {
    lines.push("## User Profile (Long-term)");
    for (const item of longTerm) {
      lines.push(`- ${item}`);
    }
  }

  if (recent.length > 0) {
    lines.push("");
    lines.push("## Recent Context");
    for (const item of recent) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}

function prioritizePinned(memories: MemoryRow[]): MemoryRow[] {
  return [...memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
    if (a.access_count !== b.access_count) return b.access_count - a.access_count;
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    return b.created_at - a.created_at;
  });
}
