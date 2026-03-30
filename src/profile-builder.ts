import type { SupermemoryConfig } from "./config.ts";
import type { MemoryDB } from "./db.ts";
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
  static: string[];
  dynamic: string[];
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Profile builder
// ---------------------------------------------------------------------------

const STATIC_CATEGORIES = new Set(["preference", "fact", "entity", "instruction"]);
const DYNAMIC_CATEGORIES = new Set(["decision", "project", "other"]);

const MAX_STATIC_ITEMS = 20;
const MAX_DYNAMIC_ITEMS = 10;
const DYNAMIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PROFILE_SCAN_LIMIT = 1000;

export function buildUserProfile(db: MemoryDB, _cfg: SupermemoryConfig): UserProfile {
  const now = Date.now();

  // Static profile: high-importance, long-lived facts
  const allActive = db.listActiveMemories(PROFILE_SCAN_LIMIT);

  const staticItems: string[] = [];
  const dynamicItems: string[] = [];
  const seen = new Set<string>();

  for (const memory of allActive) {
    if (isSyntheticMemoryText(memory.text)) continue;
    const normalized = normalizeMemoryText(memory.text);
    if (!normalized || seen.has(normalized)) continue;

    const displayText = sanitizeMemoryTextForPrompt(memory.text, 200);
    if (!displayText) continue;

    const isRecent = now - memory.created_at < DYNAMIC_WINDOW_MS;

    if (STATIC_CATEGORIES.has(memory.category) && memory.importance >= 0.5) {
      if (staticItems.length < MAX_STATIC_ITEMS) {
        staticItems.push(displayText);
        seen.add(normalized);
        continue;
      }
    }

    if (isRecent && (DYNAMIC_CATEGORIES.has(memory.category) || memory.access_count > 0)) {
      if (dynamicItems.length < MAX_DYNAMIC_ITEMS) {
        dynamicItems.push(displayText);
        seen.add(normalized);
      }
    }
  }

  // Cache the profile
  db.setProfileCache("static", staticItems);
  db.setProfileCache("dynamic", dynamicItems);

  return { static: staticItems, dynamic: dynamicItems, updatedAt: now };
}

export function getCachedProfile(db: MemoryDB): UserProfile | null {
  const staticCache = db.getProfileCache("static");
  const dynamicCache = db.getProfileCache("dynamic");

  if (!staticCache || !dynamicCache) return null;

  const staticItems = dedupeMemoryTexts(JSON.parse(staticCache.content) as string[])
    .map((item) => sanitizeMemoryTextForPrompt(item, 200))
    .filter(Boolean);
  const dynamicItems = dedupeMemoryTexts(JSON.parse(dynamicCache.content) as string[])
    .map((item) => sanitizeMemoryTextForPrompt(item, 200))
    .filter(Boolean);

  return {
    static: staticItems,
    dynamic: dynamicItems,
    updatedAt: Math.max(staticCache.updated_at, dynamicCache.updated_at),
  };
}

export function shouldRebuildProfile(
  db: MemoryDB,
  cfg: SupermemoryConfig,
  interactionCount: number,
): boolean {
  const cached = getCachedProfile(db);
  if (!cached) return true;

  // Rebuild every N interactions
  if (interactionCount % cfg.profileFrequency === 0) return true;

  // Rebuild if profile is older than 1 hour
  if (Date.now() - cached.updatedAt > 60 * 60 * 1000) return true;

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
  return getCachedProfile(db) ?? buildUserProfile(db, cfg);
}

// ---------------------------------------------------------------------------
// Format for prompt injection
// ---------------------------------------------------------------------------

export function formatProfileForPrompt(profile: UserProfile): string {
  const staticItems = dedupeMemoryTexts(profile.static)
    .map((item) => sanitizeMemoryTextForPrompt(item, 200))
    .filter(Boolean);
  const dynamicItems = dedupeMemoryTexts(profile.dynamic)
    .map((item) => sanitizeMemoryTextForPrompt(item, 200))
    .filter(Boolean);

  const lines: string[] = [];

  if (staticItems.length > 0) {
    lines.push("## User Profile (Long-term)");
    for (const item of staticItems) {
      lines.push(`- ${item}`);
    }
  }

  if (dynamicItems.length > 0) {
    lines.push("");
    lines.push("## Recent Context");
    for (const item of dynamicItems) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}
