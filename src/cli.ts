import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryConfig } from "./config.ts"
import type { ConfigDeps } from "./configure.ts"
import { registerSupermemoryConfigure } from "./configure.ts"
import type { MemoryDB } from "./db.ts"
import type { EmbeddingProvider } from "./embeddings.ts"
import { processNewMemory } from "./graph-engine.ts"
import type { PluginLogger } from "./logger.ts"
import { buildUserProfile, getOrBuildProfile } from "./profile-builder.ts"
import { hybridSearch } from "./search.ts"

type Commander = any

export function registerSupermemoryCli(
	program: Commander,
	db: MemoryDB,
	embeddings: EmbeddingProvider,
	cfg: SupermemoryConfig,
	configDeps?: ConfigDeps,
): void {
	const mem = program
		.command("supermemory")
		.description("Supermemory graph memory commands")

	mem
		.command("search")
		.description("Search memories")
		.argument("<query>", "Search query")
		.option("--limit <n>", "Max results", String(cfg.maxRecallResults))
		.action(async (query: unknown, opts: unknown) => {
			const q = query as string
			const limit = Number.parseInt(
				(opts as Record<string, string>).limit ?? String(cfg.maxRecallResults),
				10,
			)
			const results = await hybridSearch(q, db, embeddings, cfg, {
				maxResults: limit,
			})
			if (results.length === 0) {
				console.log("No memories found.")
				return
			}
			for (const r of results) {
				console.log(
					`[${r.memory.id.slice(0, 8)}] ${(r.score * 100).toFixed(0)}% [${r.memory.memory_type}] ${r.memory.text.slice(0, 120)}`,
				)
			}
		})

	mem
		.command("profile")
		.description("Show user profile")
		.option("--rebuild", "Force rebuild profile")
		.action(async (opts: unknown) => {
			const rebuild = !!(opts as Record<string, boolean>).rebuild
			const profile = rebuild
				? buildUserProfile(db, cfg)
				: getOrBuildProfile(db, cfg, 0)

			console.log("\n=== Long-Term Profile ===")
			if (profile.longTerm.length === 0) {
				console.log("  (empty)")
			} else {
				for (const item of profile.longTerm) {
					console.log(`  - ${item}`)
				}
			}

			console.log("\n=== Recent Context ===")
			if (profile.recent.length === 0) {
				console.log("  (empty)")
			} else {
				for (const item of profile.recent) {
					console.log(`  - ${item}`)
				}
			}
		})

	mem
		.command("stats")
		.description("Show memory statistics")
		.action(async () => {
			const stats = db.stats()
			console.log(`Total memories:      ${stats.totalMemories}`)
			console.log(`Active memories:     ${stats.activeMemories}`)
			console.log(`Superseded memories: ${stats.supersededMemories}`)
			console.log(`Entities:            ${stats.entities}`)
			console.log(`Relationships:       ${stats.relationships}`)
		})

	mem
		.command("wipe")
		.description("Delete all memories (requires confirmation)")
		.option("--confirm", "Confirm deletion")
		.action(async (opts: unknown) => {
			const confirm = !!(opts as Record<string, boolean>).confirm
			if (!confirm) {
				console.log("Use --confirm to delete all memories.")
				return
			}
			db.wipeAll()
			console.log("All memories deleted.")
		})

	if (configDeps) {
		registerSupermemoryConfigure(mem, configDeps)
	}
}

const SLASH_FORGET_MIN_SCORE = 0.5
const SLASH_FORGET_AUTO_DELETE_MIN_SCORE = 0.8
const SLASH_FORGET_CANDIDATE_LIMIT = 5

export function registerSlashCommands(
	api: OpenClawPluginApi,
	db: MemoryDB,
	embeddings: EmbeddingProvider,
	cfg: SupermemoryConfig,
	log: PluginLogger,
): void {
	api.registerCommand({
		name: "remember",
		description: "Save something to memory",
		acceptsArgs: true,
		requireAuth: false,
		handler: async (ctx: { args?: string }) => {
			const text = ctx.args?.trim()
			if (!text) {
				return { text: "Usage: /remember <text to remember>" }
			}

			log.debug(`/remember command: "${text.slice(0, 60)}"`)

			try {
				const memory = await processNewMemory(text, db, embeddings, {
					embeddingEnabled: cfg.embedding.enabled,
					log,
					cfg,
				})

				if (!memory) {
					return { text: "Memory could not be stored (possibly a duplicate)." }
				}

				const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text
				return { text: `Remembered: "${preview}"` }
			} catch (err) {
				log.error("/remember failed", err)
				return { text: "Failed to save memory. Check logs for details." }
			}
		},
	})

	api.registerCommand({
		name: "recall",
		description: "Search your memories",
		acceptsArgs: true,
		requireAuth: false,
		handler: async (ctx: { args?: string }) => {
			const query = ctx.args?.trim()
			if (!query) {
				return { text: "Usage: /recall <search query>" }
			}

			log.debug(`/recall command: "${query}"`)

			try {
				const results = await hybridSearch(query, db, embeddings, cfg, {
					maxResults: cfg.maxRecallResults,
				})

				if (results.length === 0) {
					return { text: `No memories found for: "${query}"` }
				}

				const lines = results.map((r, i) => {
					const pct = `(${(r.score * 100).toFixed(0)}%)`
					return `${i + 1}. [${r.memory.memory_type}] ${r.memory.text.slice(0, 120)} ${pct}`
				})

				return {
					text: `Found ${results.length} memories:\n\n${lines.join("\n")}`,
				}
			} catch (err) {
				log.error("/recall failed", err)
				return { text: "Failed to search memories. Check logs for details." }
			}
		},
	})

	api.registerCommand({
		name: "forget",
		description: "Forget a specific memory",
		acceptsArgs: true,
		requireAuth: false,
		handler: async (ctx: { args?: string }) => {
			const query = ctx.args?.trim()
			if (!query) {
				return { text: "Usage: /forget <description of what to forget>" }
			}

			log.debug(`/forget command: "${query}"`)

			try {
				const results = await hybridSearch(query, db, embeddings, cfg, {
					maxResults: SLASH_FORGET_CANDIDATE_LIMIT,
					minScore: SLASH_FORGET_MIN_SCORE,
				})

				if (results.length === 0) {
					return { text: `No matching memories found for: "${query}"` }
				}

				if (
					results.length === 1 &&
					results[0].score >= SLASH_FORGET_AUTO_DELETE_MIN_SCORE
				) {
					db.deleteMemory(results[0].memory.id)
					return {
						text: `Forgotten: "${results[0].memory.text.slice(0, 80)}${results[0].memory.text.length > 80 ? "…" : ""}"`,
					}
				}

				const list = results
					.map(
						(r, i) =>
							`${i + 1}. [${r.memory.id.slice(0, 8)}] ${r.memory.text.slice(0, 80)}…`,
					)
					.join("\n")

				return {
					text: `Found ${results.length} candidates. Use memory_forget with a memoryId to be precise:\n${list}`,
				}
			} catch (err) {
				log.error("/forget failed", err)
				return { text: "Failed to forget memory. Check logs for details." }
			}
		},
	})
}
