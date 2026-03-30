import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { registerSupermemoryCli } from "./src/cli.ts"
import { parseSupermemoryConfig, vectorDimsForModel } from "./src/config.ts"
import { MemoryDB } from "./src/db.ts"
import { createEmbeddingProvider } from "./src/embeddings.ts"
import { ForgettingService } from "./src/forgetting.ts"
import { createAutoCaptureHook, createAutoRecallHook } from "./src/hooks.ts"
import {
  createMemoryForgetTool,
  createMemoryProfileTool,
  createMemorySearchTool,
  createMemoryStoreTool,
  type ToolContext,
} from "./src/tools.ts"

export default {
  id: "openclaw-memory-supermemory",
  name: "Memory (Supermemory Local)",
  description:
    "Local graph-based memory with entity extraction, user profiles, and automatic forgetting — inspired by Supermemory",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = parseSupermemoryConfig(api.pluginConfig)
    const resolvedDbPath = api.resolvePath(cfg.dbPath)
    cfg.dbPath = resolvedDbPath

    const vectorDims = vectorDimsForModel(cfg.embedding.model, cfg.embedding.dimensions)
    const db = new MemoryDB(cfg, vectorDims)
    const embeddings = createEmbeddingProvider(cfg.embedding, vectorDims, db)

    const state = { interactionCount: 0 }

    api.logger.info(
      `memory-supermemory: initialized (db: ${resolvedDbPath}, ` +
        `embedding: ${cfg.embedding.provider}/${cfg.embedding.model}, ` +
        `vector: ${db.isVectorAvailable ? "yes" : "fts-only"})`,
    )

    // ====================================================================
    // Memory prompt section — tool usage guidance
    // ====================================================================

    api.registerMemoryPromptSection(({ availableTools }) => {
      const hasSearch = availableTools.has("memory_search")
      const hasStore = availableTools.has("memory_store")
      const hasProfile = availableTools.has("memory_profile")

      if (!hasSearch && !hasStore && !hasProfile) return []

      const lines: string[] = ["<supermemory-guidance>", "## Memory (Supermemory Graph)"]

      if (hasSearch) {
        lines.push(
          "Before answering questions about prior work, decisions, dates, people, preferences, " +
            "or projects: use memory_search to recall relevant context. The search uses hybrid " +
            "vector + keyword + graph retrieval for high recall accuracy.",
        )
      }

      if (hasStore) {
        lines.push(
          "When the user shares preferences, facts, decisions, or important context: " +
            "use memory_store to persist it. Entity extraction and relationship tracking happen automatically.",
        )
      }

      lines.push("</supermemory-guidance>")
      lines.push("")
      return lines
    })

    // ====================================================================
    // Memory flush plan — capture durable memories before compaction
    // ====================================================================

    if (typeof api.registerMemoryFlushPlan === "function") api.registerMemoryFlushPlan((params) => {
      const flushCfg = (params.cfg as Record<string, any>)?.agents?.defaults?.compaction?.memoryFlush
      if (flushCfg?.enabled === false) return null

      const softThresholdTokens =
        typeof flushCfg?.softThresholdTokens === "number" ? flushCfg.softThresholdTokens : 4000
      const forceFlushTranscriptBytes = 2 * 1024 * 1024
      const reserveTokensFloor =
        typeof (params.cfg as Record<string, any>)?.agents?.defaults?.compaction?.reserveTokensFloor === "number"
          ? (params.cfg as Record<string, any>).agents.defaults.compaction.reserveTokensFloor
          : 8192

      return {
        softThresholdTokens,
        forceFlushTranscriptBytes,
        reserveTokensFloor,
        prompt:
          "Pre-compaction memory flush. Use memory_store to save any important context, " +
          "facts, decisions, or preferences from this conversation that should be remembered " +
          "long-term. The graph memory engine will handle entity extraction and relationships. " +
          "If nothing to store, reply with \u2300.",
        systemPrompt:
          "Pre-compaction memory flush turn. The session is near auto-compaction. " +
          "Use memory_store to capture durable memories. You may reply, but usually \u2300 is correct.",
        relativePath: "memory/supermemory-flush.md",
      }
    })

    // ====================================================================
    // Memory runtime — MemoryPluginRuntime for core integration
    // ====================================================================

    if (typeof api.registerMemoryRuntime === "function") api.registerMemoryRuntime({
      async getMemorySearchManager() {
        try {
          const { hybridSearch } = await import("./src/search.ts")
          const manager = {
            async search(
              query: string,
              opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
            ) {
              const results = await hybridSearch(query, db, embeddings, cfg, {
                maxResults: opts?.maxResults,
                minScore: opts?.minScore,
              })
              return results.map((r) => ({
                path: `supermemory://${r.memory.id}`,
                startLine: 0,
                endLine: 0,
                score: r.score,
                snippet: r.memory.text,
                source: "memory" as const,
              }))
            },
            async readFile(params: { relPath: string; from?: number; lines?: number }) {
              const idMatch = params.relPath.match(/^supermemory:\/\/(.+)$/)
              if (idMatch) {
                const memory = db.getMemory(idMatch[1])
                if (memory) {
                  return { text: memory.text, path: params.relPath }
                }
              }
              return { text: "", path: params.relPath }
            },
            status() {
              const stats = db.stats()
              return {
                backend: "builtin" as const,
                provider: cfg.embedding.provider,
                model: cfg.embedding.model,
                files: stats.activeMemories,
                chunks: stats.totalMemories,
                dirty: false,
                dbPath: resolvedDbPath,
                sources: ["memory" as const],
                vector: {
                  enabled: true,
                  available: db.isVectorAvailable,
                  dims: vectorDims,
                },
                custom: {
                  engine: "supermemory",
                  entities: stats.entities,
                  relationships: stats.relationships,
                  searchMode: db.isVectorAvailable ? "hybrid" : "fts-only",
                },
              }
            },
            async sync() {
              // No-op — supermemory captures memories via hooks/tools, not file sync
            },
            async probeEmbeddingAvailability() {
              try {
                await embeddings.embed("test")
                return { ok: true }
              } catch (err) {
                return {
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                }
              }
            },
            async probeVectorAvailability() {
              return db.isVectorAvailable
            },
            async close() {
              db.close()
            },
          }
          return { manager }
        } catch (err) {
          return {
            manager: null,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const }
      },
      async closeAllMemorySearchManagers() {
        db.close()
      },
    })

    // ====================================================================
    // Tools
    // ====================================================================

    const toolCtx: ToolContext = {
      db,
      embeddings,
      cfg,
      get interactionCount() {
        return state.interactionCount
      },
      set interactionCount(v: number) {
        state.interactionCount = v
      },
    }

    api.registerTool(createMemorySearchTool(toolCtx), { name: "memory_search" })
    api.registerTool(createMemoryStoreTool(toolCtx), { name: "memory_store" })
    api.registerTool(createMemoryForgetTool(toolCtx), { name: "memory_forget" })
    api.registerTool(createMemoryProfileTool(toolCtx), { name: "memory_profile" })

    // ====================================================================
    // Lifecycle hooks
    // ====================================================================

    if (cfg.autoRecall) {
      api.on(
        "before_prompt_build",
        createAutoRecallHook(db, embeddings, cfg, state, api.logger),
      )
    }

    if (cfg.autoCapture && cfg.captureMode !== "off") {
      const subagent = (api as unknown as { runtime?: { subagent?: unknown } }).runtime?.subagent ?? null;
      if (!subagent) {
        api.logger.warn(
          "memory-supermemory: subagent runtime not available — auto-capture (LLM fact extraction) is disabled. " +
          "The memory_store tool still works for manual capture.",
        )
      }
      api.on(
        "agent_end",
        createAutoCaptureHook(db, embeddings, cfg, api.logger, subagent as any),
      )
    }

    // ====================================================================
    // CLI
    // ====================================================================

    api.registerCli(
      ({ program }: { program: unknown }) => {
        registerSupermemoryCli(program, db, embeddings, cfg)
      },
      {
        commands: ["supermemory"],
        descriptors: [
          {
            name: "supermemory",
            description: "Graph memory: search, profile, stats, wipe",
            hasSubcommands: true,
          },
        ],
      },
    )

    // ====================================================================
    // Background service — forgetting + profile rebuild
    // ====================================================================

    const forgettingService = new ForgettingService(db, cfg, api.logger)

    api.registerService({
      id: "openclaw-memory-supermemory",
      start: () => {
        forgettingService.start()
        api.logger.info(
          "memory-supermemory: service started " +
            `(autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, ` +
            `forgetting: every ${cfg.forgetExpiredIntervalMinutes}min)`,
        )
      },
      stop: () => {
        forgettingService.stop()
        db.close()
        api.logger.info("memory-supermemory: service stopped")
      },
    })
  },
}
