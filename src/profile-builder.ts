import type { SupermemoryConfig } from "./config.ts";
import type { MemoryDB } from "./db.ts";

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

export function buildUserProfile(db: MemoryDB, _cfg: SupermemoryConfig): UserProfile {
  const now = Date.now();

  // Static profile: high-importance, long-lived facts
  const allActive = db.listActiveMemories(200);

  const staticItems: string[] = [];
  const dynamicItems: string[] = [];

  for (const memory of allActive) {
    const isRecent = now - memory.created_at < DYNAMIC_WINDOW_MS;

    if (STATIC_CATEGORIES.has(memory.category) && memory.importance >= 0.5) {
      if (staticItems.length < MAX_STATIC_ITEMS) {
        staticItems.push(memory.text);
      }
    }

    if (isRecent && (DYNAMIC_CATEGORIES.has(memory.category) || memory.access_count > 0)) {
      if (dynamicItems.length < MAX_DYNAMIC_ITEMS) {
        dynamicItems.push(memory.text);
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

  return {
    static: JSON.parse(staticCache.content) as string[],
    dynamic: JSON.parse(dynamicCache.content) as string[],
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
  const lines: string[] = [];

  if (profile.static.length > 0) {
    lines.push("## User Profile (Long-term)");
    for (const item of profile.static) {
      lines.push(`- ${escapeForPrompt(item)}`);
    }
  }

  if (profile.dynamic.length > 0) {
    lines.push("");
    lines.push("## Recent Context");
    for (const item of profile.dynamic) {
      lines.push(`- ${escapeForPrompt(item)}`);
    }
  }

  return lines.join("\n");
}

function escapeForPrompt(text: string): string {
  return text
    .replace(/[<>]/g, "")
    .replace(/\n/g, " ")
    .slice(0, 200);
}
