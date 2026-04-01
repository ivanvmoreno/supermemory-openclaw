import type { SupermemoryConfig } from "./config.ts";
import type { MemoryDB, MemoryRow } from "./db.ts";
import {
  dedupeMemoryTexts,
  normalizeMemoryText,
  sanitizeMemoryTextForPrompt,
  isSyntheticMemoryText,
} from "./memory-text.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserProfile = {
  longTerm: string[];
  recent: string[];
  updatedAt: number;
};

const PROFILE_REBUILD_MAX_AGE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Profile builder
// ---------------------------------------------------------------------------

export function buildUserProfile(db: MemoryDB, cfg: SupermemoryConfig): UserProfile {
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
): boolean {
  const cached = getCachedProfile(db, cfg);
  if (!cached) return true;

  if (interactionCount > 0 && interactionCount % cfg.profileFrequency === 0) return true;
  if (Date.now() - cached.updatedAt > PROFILE_REBUILD_MAX_AGE_MS) return true;

  return false;
}

export function getOrBuildProfile(
  db: MemoryDB,
  cfg: SupermemoryConfig,
  interactionCount: number,
): UserProfile {
  if (shouldRebuildProfile(db, cfg, interactionCount)) {
    return buildUserProfile(db, cfg);
  }
  return getCachedProfile(db, cfg) ?? buildUserProfile(db, cfg);
}

// ---------------------------------------------------------------------------
// Format for prompt injection
// ---------------------------------------------------------------------------

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
