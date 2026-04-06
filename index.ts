import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { registerSlashCommands, registerSupermemoryCli } from "./src/cli.ts"
import {
	parseSupermemoryConfig,
	supermemoryConfigSchema,
	vectorDimsForModel,
} from "./src/config.ts"
import { MemoryDB } from "./src/db.ts"
import { createEmbeddingProvider } from "./src/embeddings.ts"
import { ForgettingService } from "./src/forgetting.ts"
import { createAutoCaptureHook, createAutoRecallHook } from "./src/hooks.ts"
import { createPluginLogger } from "./src/logger.ts"
import { resolveSearchMode } from "./src/search.ts"
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
	configSchema: supermemoryConfigSchema,

	register(api: OpenClawPluginApi) {
		const cfg = parseSupermemoryConfig(api.pluginConfig)
		const resolvedDbPath = api.resolvePath(cfg.dbPath)
		cfg.dbPath = resolvedDbPath

		const vectorDims = cfg.embedding.enabled
			? vectorDimsForModel(cfg.embedding.model, cfg.embedding.dimensions)
			: 0
		const db = new MemoryDB(cfg, vectorDims)
		const embeddings = createEmbeddingProvider(cfg.embedding, vectorDims, db)
		const subagent =
			(api as unknown as { runtime?: { subagent?: unknown } }).runtime
				?.subagent ?? null

		const state = { interactionCount: 0 }
		const log = createPluginLogger(api.logger, "memory-supermemory", cfg.debug)

		log.info(
			`initialized (db: ${resolvedDbPath}, ` +
				(cfg.embedding.enabled
					? `embedding: ${cfg.embedding.provider}/${cfg.embedding.model}, `
					: "embedding: disabled, ") +
				`search: ${resolveSearchMode(cfg, db)}, debug: ${cfg.debug})`,
		)

		api.registerMemoryPromptSection(({ availableTools }) => {
			const hasSearch = availableTools.has("memory_search")
			const hasStore = availableTools.has("memory_store")
			const hasProfile = availableTools.has("memory_profile")

			if (!hasSearch && !hasStore && !hasProfile) return []

			const lines: string[] = [
				"<supermemory-guidance>",
				"## Memory (Supermemory Graph)",
			]

			if (hasSearch) {
				const searchMode = resolveSearchMode(cfg, db)
				lines.push(
					"Before answering questions about prior work, decisions, dates, people, preferences, " +
						"or projects: use memory_search to recall relevant context. The search uses " +
						(searchMode === "hybrid"
							? "vector + keyword + graph retrieval for high recall accuracy."
							: searchMode === "fts+graph"
								? "keyword + graph retrieval."
								: "keyword retrieval."),
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

		if (typeof api.registerMemoryFlushPlan === "function")
			api.registerMemoryFlushPlan((params) => {
				const flushCfg = (params.cfg as Record<string, any>)?.agents?.defaults
					?.compaction?.memoryFlush
				if (flushCfg?.enabled === false) return null

				const softThresholdTokens =
					typeof flushCfg?.softThresholdTokens === "number"
						? flushCfg.softThresholdTokens
						: 4000
				const forceFlushTranscriptBytes = 2 * 1024 * 1024
				const reserveTokensFloor =
					typeof (params.cfg as Record<string, any>)?.agents?.defaults
						?.compaction?.reserveTokensFloor === "number"
						? (params.cfg as Record<string, any>).agents.defaults.compaction
								.reserveTokensFloor
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

		if (typeof api.registerMemoryRuntime === "function")
			api.registerMemoryRuntime({
				async getMemorySearchManager() {
					try {
						const { hybridSearch } = await import("./src/search.ts")
						const manager = {
							async search(
								query: string,
								opts?: {
									maxResults?: number
									minScore?: number
									sessionKey?: string
								},
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
							async readFile(params: {
								relPath: string
								from?: number
								lines?: number
							}) {
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
								const vectorStats = db.getVectorBackfillStats()
								const searchMode = resolveSearchMode(cfg, db)
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
										enabled: cfg.embedding.enabled,
										available: cfg.embedding.enabled && db.isVectorAvailable,
										dims: cfg.embedding.enabled ? vectorDims : null,
										indexed: cfg.embedding.enabled ? vectorStats.indexed : 0,
										pendingBackfill: cfg.embedding.enabled
											? vectorStats.pendingBackfill
											: 0,
									},
									custom: {
										engine: "supermemory",
										entities: stats.entities,
										relationships: stats.relationships,
										searchMode,
									},
								}
							},
							async sync() {
								// No-op — supermemory captures memories via hooks/tools, not file sync
							},
							async probeEmbeddingAvailability() {
								if (!cfg.embedding.enabled) {
									return {
										ok: false,
										disabled: true,
										error: "Embeddings are disabled by configuration.",
									}
								}
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
								return cfg.embedding.enabled && db.isVectorAvailable
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

		const toolCtx: ToolContext = {
			db,
			embeddings,
			cfg,
			semanticRuntime: subagent as any,
			log,
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
		api.registerTool(createMemoryProfileTool(toolCtx), {
			name: "memory_profile",
		})

		registerSlashCommands(api, db, embeddings, cfg, log)

		if (
			cfg.embedding.enabled &&
			typeof api.registerMemoryEmbeddingProvider === "function"
		) {
			api.registerMemoryEmbeddingProvider({
				embed: (text: string) => embeddings.embed(text),
				embedBatch: (texts: string[]) => embeddings.embedBatch(texts),
				get dimensions() {
					return embeddings.dimensions
				},
			})
		}

		if (cfg.autoRecall) {
			api.on(
				"before_prompt_build",
				createAutoRecallHook(db, embeddings, cfg, state, log),
			)
		}

		if (cfg.autoCapture && cfg.captureMode !== "off") {
			if (!subagent) {
				log.warn(
					"subagent runtime not available — auto-capture (LLM semantic extraction) is disabled. " +
						"The memory_store tool will fall back to direct storage when semantic extraction is unavailable.",
				)
			}
			api.on(
				"agent_end",
				createAutoCaptureHook(db, embeddings, cfg, log, subagent as any),
			)
		}

		api.registerCli(
			({ program }: { program: unknown }) => {
				registerSupermemoryCli(program, db, embeddings, cfg, {
					loadConfig: api.runtime.config.loadConfig,
					writeConfigFile: api.runtime.config.writeConfigFile,
				})
			},
			{
				commands: ["supermemory"],
				descriptors: [
					{
						name: "supermemory",
						description:
							"Graph memory: search, profile, stats, wipe, configure",
						hasSubcommands: true,
					},
				],
			},
		)

		const forgettingService = new ForgettingService(db, cfg, log, {
			embeddings,
			semanticRuntime: subagent as any,
		})

		api.registerService({
			id: "openclaw-memory-supermemory",
			start: () => {
				forgettingService.start()
				log.info(
					"service started " +
						`(autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, ` +
						`forgetting: every ${cfg.forgetExpiredIntervalMinutes}min)`,
				)
			},
			stop: () => {
				forgettingService.stop()
				db.close()
				log.info("service stopped")
			},
		})
	},
}
