import { Type } from "@sinclair/typebox";
import { MEMORY_CATEGORIES, type MemoryCategory, type SupermemoryConfig } from "./config.ts";
import type { MemoryDB } from "./db.ts";
import type { EmbeddingProvider } from "./embeddings.ts";
import { processNewMemory } from "./graph-engine.ts";
import { getOrBuildProfile, type UserProfile } from "./profile-builder.ts";
import { hybridSearch } from "./search.ts";

// ---------------------------------------------------------------------------
// Types matching OpenClaw tool shape
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

type ToolExecuteFn = (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;

export type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: ToolExecuteFn;
};

// ---------------------------------------------------------------------------
// Shared state holder
// ---------------------------------------------------------------------------

export type ToolContext = {
  db: MemoryDB;
  embeddings: EmbeddingProvider;
  cfg: SupermemoryConfig;
  interactionCount: number;
};

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

export function createMemorySearchTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search long-term memory using hybrid vector + keyword + graph retrieval. " +
      "Use when you need context about user preferences, past decisions, people, projects, or previously discussed topics.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      containerTag: Type.Optional(Type.String({ description: "Filter by container tag" })),
    }),
    async execute(_toolCallId, params) {
      const query = params.query as string;
      const limit = (params.limit as number) ?? ctx.cfg.maxRecallResults;
      const containerTag = params.containerTag as string | undefined;

      const results = await hybridSearch(query, ctx.db, ctx.embeddings, ctx.cfg, {
        maxResults: limit,
        containerTag,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No relevant memories found." }],
          details: { count: 0 },
        };
      }

      const text = results
        .map(
          (r, i) =>
            `${i + 1}. [${r.memory.category}] ${r.memory.text.slice(0, 200)} (${(r.score * 100).toFixed(0)}%, via ${r.source})`,
        )
        .join("\n");

      return {
        content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
        details: {
          count: results.length,
          memories: results.map((r) => ({
            id: r.memory.id,
            text: r.memory.text,
            category: r.memory.category,
            importance: r.memory.importance,
            score: r.score,
            source: r.source,
          })),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// memory_store
// ---------------------------------------------------------------------------

export function createMemoryStoreTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_store",
    label: "Memory Store",
    description:
      "Save important information in long-term graph memory. Automatically extracts entities, detects relationships, and handles deduplication. " +
      "Use for preferences, facts, decisions, project context, instructions.",
    parameters: Type.Object({
      text: Type.String({ description: "Information to remember" }),
      importance: Type.Optional(
        Type.Number({ description: "Importance 0-1 (auto-detected if omitted)" }),
      ),
      category: Type.Optional(
        Type.Unsafe<MemoryCategory>({
          type: "string",
          enum: [...MEMORY_CATEGORIES],
          description: "Memory category (auto-detected if omitted)",
        }),
      ),
      containerTag: Type.Optional(Type.String({ description: "Container tag for scoping" })),
    }),
    async execute(_toolCallId, params) {
      const text = params.text as string;
      const importance = params.importance as number | undefined;
      const category = params.category as MemoryCategory | undefined;
      const containerTag = params.containerTag as string | undefined;

      const memory = await processNewMemory(text, ctx.db, ctx.embeddings, {
        containerTag,
        categoryOverride: category,
        importanceOverride: importance,
      });

      const entities = ctx.db.getEntitiesForMemory(memory.id);
      const relationships = ctx.db.getRelationshipsForMemory(memory.id);

      return {
        content: [
          {
            type: "text",
            text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" [${memory.category}, importance: ${memory.importance.toFixed(2)}]` +
              (entities.length > 0
                ? `\nEntities: ${entities.map((e) => `${e.name} (${e.type})`).join(", ")}`
                : "") +
              (relationships.length > 0
                ? `\nRelationships: ${relationships.map((r) => `${r.relation_type} → ${r.target_id.slice(0, 8)}`).join(", ")}`
                : ""),
          },
        ],
        details: {
          action: "created",
          id: memory.id,
          category: memory.category,
          importance: memory.importance,
          entities: entities.map((e) => ({ name: e.name, type: e.type })),
          relationships: relationships.map((r) => ({
            type: r.relation_type,
            targetId: r.target_id,
            confidence: r.confidence,
          })),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// memory_forget
// ---------------------------------------------------------------------------

export function createMemoryForgetTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_forget",
    label: "Memory Forget",
    description: "Delete specific memories by ID or search query.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search to find memory to forget" })),
      memoryId: Type.Optional(Type.String({ description: "Specific memory ID to delete" })),
    }),
    async execute(_toolCallId, params) {
      const query = params.query as string | undefined;
      const memoryId = params.memoryId as string | undefined;

      if (memoryId) {
        const deleted = ctx.db.deleteMemory(memoryId);
        return {
          content: [
            {
              type: "text",
              text: deleted ? `Memory ${memoryId} forgotten.` : `Memory ${memoryId} not found.`,
            },
          ],
          details: { action: deleted ? "deleted" : "not_found", id: memoryId },
        };
      }

      if (query) {
        const results = await hybridSearch(query, ctx.db, ctx.embeddings, ctx.cfg, {
          maxResults: 5,
          minScore: 0.5,
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No matching memories found." }],
            details: { found: 0 },
          };
        }

        if (results.length === 1 && results[0].score > 0.8) {
          ctx.db.deleteMemory(results[0].memory.id);
          return {
            content: [
              {
                type: "text",
                text: `Forgotten: "${results[0].memory.text.slice(0, 80)}..."`,
              },
            ],
            details: { action: "deleted", id: results[0].memory.id },
          };
        }

        const list = results
          .map((r) => `- [${r.memory.id.slice(0, 8)}] ${r.memory.text.slice(0, 60)}...`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
            },
          ],
          details: {
            action: "candidates",
            candidates: results.map((r) => ({
              id: r.memory.id,
              text: r.memory.text,
              score: r.score,
            })),
          },
        };
      }

      return {
        content: [{ type: "text", text: "Provide query or memoryId." }],
        details: { error: "missing_param" },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// memory_profile
// ---------------------------------------------------------------------------

export function createMemoryProfileTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "memory_profile",
    label: "Memory Profile",
    description:
      "View the automatically maintained user profile. Shows static (long-term facts) and dynamic (recent context) information.",
    parameters: Type.Object({
      rebuild: Type.Optional(
        Type.Boolean({ description: "Force rebuild the profile (default: false)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const rebuild = (params.rebuild as boolean) ?? false;

      let profile: UserProfile;
      if (rebuild) {
        const { buildUserProfile } = await import("./profile-builder.ts");
        profile = buildUserProfile(ctx.db, ctx.cfg);
      } else {
        profile = getOrBuildProfile(ctx.db, ctx.cfg, ctx.interactionCount);
      }

      const stats = ctx.db.stats();

      const staticText =
        profile.static.length > 0
          ? profile.static.map((s, i) => `${i + 1}. ${s}`).join("\n")
          : "(no long-term facts yet)";

      const dynamicText =
        profile.dynamic.length > 0
          ? profile.dynamic.map((s, i) => `${i + 1}. ${s}`).join("\n")
          : "(no recent context)";

      return {
        content: [
          {
            type: "text",
            text:
              `**User Profile**\n\n` +
              `**Static (long-term):**\n${staticText}\n\n` +
              `**Dynamic (recent):**\n${dynamicText}\n\n` +
              `**Stats:** ${stats.activeMemories} active memories, ${stats.entities} entities, ${stats.relationships} relationships`,
          },
        ],
        details: {
          profile: { static: profile.static, dynamic: profile.dynamic },
          stats,
        },
      };
    },
  };
}
