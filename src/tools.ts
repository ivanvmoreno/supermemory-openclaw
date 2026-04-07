import { Type } from "@sinclair/typebox"
import {
	MEMORY_TYPES,
	type MemoryType,
	type SupermemoryConfig,
} from "./config.ts"
import type { MemoryDB } from "./db.ts"
import type { EmbeddingProvider } from "./embeddings.ts"
import { extractMemoryCandidates } from "./fact-extractor.ts"
import { processNewMemory } from "./graph-engine.ts"
import type { PluginLogger } from "./logger.ts"
import { getOrBuildProfile, type UserProfile } from "./profile-builder.ts"
import { hybridSearch, resolveSearchMode } from "./search.ts"
import type { SemanticSubagentRuntime } from "./semantic-runtime.ts"

type ToolResult = {
	content: Array<{ type: string; text: string }>
	details?: Record<string, unknown>
}

type MemoryStoreToolRuntimeContext = {
	agentId?: string
	sessionKey?: string
	sessionId?: string
}

type ToolExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
) => Promise<ToolResult>

export type ToolDefinition = {
	name: string
	label: string
	description: string
	parameters: unknown
	execute: ToolExecuteFn
}

export type ToolContext = {
	db: MemoryDB
	embeddings: EmbeddingProvider
	cfg: SupermemoryConfig
	interactionCount: number
	semanticRuntime?: SemanticSubagentRuntime | null
	log: PluginLogger
}

const FORGET_SEARCH_CANDIDATE_LIMIT = 5
const FORGET_SEARCH_MIN_SCORE = 0.5
const FORGET_AUTO_DELETE_MIN_SCORE = 0.8

export function createMemorySearchTool(ctx: ToolContext): ToolDefinition {
	const searchMode = resolveSearchMode(ctx.cfg, ctx.db)
	const description =
		searchMode === "hybrid"
			? "Search long-term memory using vector + keyword + graph retrieval. Use when you need context about user preferences, facts, episodes, people, projects, or previous decisions."
			: searchMode === "fts+graph"
				? "Search long-term memory using keyword + graph retrieval. Use when you need context about user preferences, facts, episodes, people, projects, or previous decisions."
				: "Search long-term memory using keyword retrieval. Use when you need context about user preferences, facts, episodes, people, projects, or previous decisions."

	return {
		name: "memory_search",
		label: "Memory Search",
		description,
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(
				Type.Number({
					description: "Max results (default: configured maxRecallResults)",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const query = params.query as string
			const limit = (params.limit as number) ?? ctx.cfg.maxRecallResults

			const results = await hybridSearch(
				query,
				ctx.db,
				ctx.embeddings,
				ctx.cfg,
				{
					maxResults: limit,
				},
				ctx.log,
			)

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No relevant memories found." }],
					details: { count: 0, mode: resolveSearchMode(ctx.cfg, ctx.db) },
				}
			}

			const text = results
				.map(
					(result, index) =>
						`${index + 1}. [${result.memory.memory_type}] ${result.memory.text.slice(0, 200)} (${(result.score * 100).toFixed(0)}%, via ${result.source})`,
				)
				.join("\n")

			return {
				content: [
					{
						type: "text",
						text: `Found ${results.length} memories:\n\n${text}`,
					},
				],
				details: {
					count: results.length,
					mode: resolveSearchMode(ctx.cfg, ctx.db),
					memories: results.map((result) => ({
						id: result.memory.id,
						text: result.memory.text,
						memoryType: result.memory.memory_type,
						pinned: result.memory.pinned,
						score: result.score,
						source: result.source,
					})),
				},
			}
		},
	}
}

export function createMemoryStoreTool(
	ctx: ToolContext,
	toolCtx?: MemoryStoreToolRuntimeContext,
): ToolDefinition {
	return {
		name: "memory_store",
		label: "Memory Store",
		description:
			"Save important information in long-term graph memory. Automatically extracts entities, detects relationships, and handles deduplication. " +
			"Use for facts, preferences, and episodes.",
		parameters: Type.Object({
			text: Type.String({ description: "Information to remember" }),
			memoryType: Type.Optional(
				Type.Unsafe<MemoryType>({
					type: "string",
					enum: [...MEMORY_TYPES],
					description: "Memory type (auto-detected if omitted)",
				}),
			),
			pinned: Type.Optional(
				Type.Boolean({
					description: "Pin this memory so it never decays automatically",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const semanticScope =
				ctx.semanticRuntime !== null && ctx.semanticRuntime !== undefined
					? {
							agentId: toolCtx?.agentId,
							scopeKey:
								_toolCallId ||
								toolCtx?.sessionId ||
								toolCtx?.sessionKey ||
								undefined,
						}
					: null
			const text = params.text as string
			const memoryType = params.memoryType as MemoryType | undefined
			const pinned = params.pinned as boolean | undefined

			let storedMemories = []
			if (ctx.semanticRuntime) {
				const extracted = await extractMemoryCandidates(
					text,
					ctx.semanticRuntime,
					ctx.log,
					{
						referenceTimeMs: Date.now(),
						maxItems: ctx.cfg.extractorMaxItems,
						semanticScope,
					},
				)

				for (const candidate of extracted) {
					const memory = await processNewMemory(
						candidate.text,
						ctx.db,
						ctx.embeddings,
						{
							embeddingEnabled: ctx.cfg.embedding.enabled,
							memoryTypeOverride: memoryType,
							pinnedOverride: pinned,
							semanticMemory: candidate,
							semanticRuntime: ctx.semanticRuntime,
							semanticScope,
							log: ctx.log,
							cfg: ctx.cfg,
						},
					)
					if (memory) {
						storedMemories.push(memory)
					}
				}
			}

			if (storedMemories.length === 0) {
				const fallback = await processNewMemory(text, ctx.db, ctx.embeddings, {
					embeddingEnabled: ctx.cfg.embedding.enabled,
					memoryTypeOverride: memoryType,
					pinnedOverride: pinned,
					semanticRuntime: ctx.semanticRuntime ?? null,
					semanticScope,
					log: ctx.log,
					cfg: ctx.cfg,
				})
				if (fallback) {
					storedMemories = [fallback]
				}
			}

			if (storedMemories.length === 0) {
				return {
					content: [{ type: "text", text: "The memory could not be stored." }],
					details: { action: "skipped" },
				}
			}

			const details = storedMemories.map((memory) => {
				const entities = ctx.db.getEntityMentionsForMemory(memory.id)
				const relationships = ctx.db.getRelationshipsForMemory(memory.id)
				return {
					id: memory.id,
					memoryType: memory.memory_type,
					pinned: memory.pinned,
					entities: entities.map((entity) => ({
						aliasId: entity.alias_id,
						entityId: entity.entity_id,
						mention: entity.surface_text,
						canonicalName: entity.canonical_name,
						kind: entity.alias_kind ?? entity.canonical_kind ?? null,
					})),
					relationships: relationships.map((relationship) => ({
						type: relationship.relation_type,
						targetId: relationship.target_id,
					})),
				}
			})

			const summaryLines = storedMemories.map((memory, index) => {
				const entities = ctx.db.getEntityMentionsForMemory(memory.id)
				const relationships = ctx.db.getRelationshipsForMemory(memory.id)
				return (
					`${index + 1}. [${memory.memory_type}] "${memory.text.slice(0, 100)}${memory.text.length > 100 ? "..." : ""}"` +
					(memory.pinned ? " (pinned)" : "") +
					(entities.length > 0
						? `\n   Entities: ${entities
								.map((entity) =>
									formatEntityMentionForDisplay({
										mention: entity.surface_text,
										canonicalName: entity.canonical_name,
										kind: entity.alias_kind ?? entity.canonical_kind ?? null,
									}),
								)
								.join(", ")}`
						: "") +
					(relationships.length > 0
						? `\n   Relationships: ${relationships.map((relationship) => `${relationship.relation_type} -> ${relationship.target_id.slice(0, 8)}`).join(", ")}`
						: "")
				)
			})

			return {
				content: [
					{
						type: "text",
						text:
							(storedMemories.length === 1
								? "Stored 1 memory:\n"
								: `Stored ${storedMemories.length} memories:\n`) +
							summaryLines.join("\n"),
					},
				],
				details: {
					action: "stored",
					count: storedMemories.length,
					memories: details,
				},
			}
		},
	}
}

function formatEntityMentionForDisplay(entity: {
	mention: string
	canonicalName: string
	kind: string | null
}): string {
	const base =
		entity.mention === entity.canonicalName
			? entity.mention
			: `${entity.mention} -> ${entity.canonicalName}`
	return entity.kind ? `${base} (${entity.kind})` : base
}

export function createMemoryForgetTool(ctx: ToolContext): ToolDefinition {
	return {
		name: "memory_forget",
		label: "Memory Forget",
		description: "Delete specific memories by ID or search query.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Search to find memory to forget" }),
			),
			memoryId: Type.Optional(
				Type.String({ description: "Specific memory ID to delete" }),
			),
		}),
		async execute(_toolCallId, params) {
			const query = params.query as string | undefined
			const memoryId = params.memoryId as string | undefined

			if (memoryId) {
				const deleted = ctx.db.deleteMemory(memoryId)
				return {
					content: [
						{
							type: "text",
							text: deleted
								? `Memory ${memoryId} forgotten.`
								: `Memory ${memoryId} not found.`,
						},
					],
					details: { action: deleted ? "deleted" : "not_found", id: memoryId },
				}
			}

			if (query) {
				const results = await hybridSearch(
					query,
					ctx.db,
					ctx.embeddings,
					ctx.cfg,
					{
						maxResults: FORGET_SEARCH_CANDIDATE_LIMIT,
						minScore: FORGET_SEARCH_MIN_SCORE,
					},
					ctx.log,
				)

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No matching memories found." }],
						details: { found: 0 },
					}
				}

				if (
					results.length === 1 &&
					results[0].score > FORGET_AUTO_DELETE_MIN_SCORE
				) {
					ctx.db.deleteMemory(results[0].memory.id)
					return {
						content: [
							{
								type: "text",
								text: `Forgotten: "${results[0].memory.text.slice(0, 80)}..."`,
							},
						],
						details: { action: "deleted", id: results[0].memory.id },
					}
				}

				const list = results
					.map(
						(result) =>
							`- [${result.memory.id.slice(0, 8)}] ${result.memory.text.slice(0, 60)}...`,
					)
					.join("\n")

				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
						},
					],
					details: {
						action: "candidates",
						candidates: results.map((result) => ({
							id: result.memory.id,
							text: result.memory.text,
							score: result.score,
						})),
					},
				}
			}

			return {
				content: [{ type: "text", text: "Provide query or memoryId." }],
				details: { error: "missing_param" },
			}
		},
	}
}

export function createMemoryProfileTool(ctx: ToolContext): ToolDefinition {
	return {
		name: "memory_profile",
		label: "Memory Profile",
		description:
			"View the automatically maintained user profile. Shows long-term memories and recent episodic context.",
		parameters: Type.Object({
			rebuild: Type.Optional(
				Type.Boolean({
					description: "Force rebuild the profile (default: false)",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const rebuild = (params.rebuild as boolean) ?? false

			let profile: UserProfile
			if (rebuild) {
				const { buildUserProfile } = await import("./profile-builder.ts")
				profile = buildUserProfile(ctx.db, ctx.cfg)
			} else {
				profile = getOrBuildProfile(
					ctx.db,
					ctx.cfg,
					ctx.interactionCount,
					ctx.log,
				)
			}

			const stats = ctx.db.stats()

			const longTermText =
				profile.longTerm.length > 0
					? profile.longTerm
							.map((item, index) => `${index + 1}. ${item}`)
							.join("\n")
					: "(no long-term memories yet)"

			const recentText =
				profile.recent.length > 0
					? profile.recent
							.map((item, index) => `${index + 1}. ${item}`)
							.join("\n")
					: "(no recent context)"

			return {
				content: [
					{
						type: "text",
						text:
							"**User Profile**\n\n" +
							`**Long-term:**\n${longTermText}\n\n` +
							`**Recent:**\n${recentText}\n\n` +
							`**Stats:** ${stats.activeMemories} active memories, ${stats.entities} entities, ${stats.relationships} relationships`,
					},
				],
				details: {
					profile: { longTerm: profile.longTerm, recent: profile.recent },
					stats,
				},
			}
		},
	}
}
