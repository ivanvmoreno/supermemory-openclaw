import { homedir } from "node:os"
import { join } from "node:path"
import {
	DEFAULT_EMBEDDING_PROVIDER,
	getDefaultEmbeddingModelForProvider,
	KNOWN_EMBEDDING_DIMENSIONS,
} from "./embedding-catalog.ts"

export type EmbeddingConfig = {
	enabled: boolean
	provider: string
	model: string
	apiKey?: string
	baseUrl?: string
	dimensions?: number
}

export type MemoryType = (typeof MEMORY_TYPES)[number]
export const MEMORY_TYPES = ["fact", "preference", "episode"] as const

export type RelationType = "updates" | "related"

export type SupermemoryConfig = {
	embedding: EmbeddingConfig
	autoCapture: boolean
	autoRecall: boolean
	profileFrequency: number
	maxLongTermItems: number
	maxRecentItems: number
	recentWindowDays: number
	profileScanLimit: number
	promptMemoryMaxChars: number
	forgetExpiredIntervalMinutes: number
	temporalDecayDays: number
	maxRecallResults: number
	vectorWeight: number
	textWeight: number
	graphWeight: number
	dbPath: string
	captureMaxChars: number
	debug: boolean
	minScore: number
	vectorMinScoreFactor: number
	graphSeedLimit: number
	graphHopDepth: number
	mmrLambda: number
	autoRecallMaxMemories: number
	autoRecallMinScore: number
	nearDuplicateThreshold: number
	lexicalDuplicateThreshold: number
	updateVectorMinScore: number
	maxRelatedEdges: number
	extractorMaxItems: number
}

const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "supermemory.db")
const DEFAULT_PROFILE_FREQUENCY = 50
const DEFAULT_MAX_LONG_TERM_ITEMS = 20
const DEFAULT_MAX_RECENT_ITEMS = 10
const DEFAULT_RECENT_WINDOW_DAYS = 7
const DEFAULT_PROFILE_SCAN_LIMIT = 1000
const DEFAULT_PROMPT_MEMORY_MAX_CHARS = 500
const DEFAULT_FORGET_INTERVAL_MINUTES = 60
const DEFAULT_TEMPORAL_DECAY_DAYS = 90
const DEFAULT_MAX_RECALL_RESULTS = 10
const DEFAULT_VECTOR_WEIGHT = 0.5
const DEFAULT_TEXT_WEIGHT = 0.3
const DEFAULT_GRAPH_WEIGHT = 0.2
const DEFAULT_CAPTURE_MAX_CHARS = 2000
const DEFAULT_MIN_SCORE = 0.1
const DEFAULT_VECTOR_MIN_SCORE_FACTOR = 0.5
const DEFAULT_GRAPH_SEED_LIMIT = 5
const DEFAULT_GRAPH_HOP_DEPTH = 2
const DEFAULT_MMR_LAMBDA = 0.7
const DEFAULT_AUTO_RECALL_MAX_MEMORIES = 5
const DEFAULT_AUTO_RECALL_MIN_SCORE = 0.3
const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.95
const DEFAULT_LEXICAL_DUPLICATE_THRESHOLD = 0.88
const DEFAULT_UPDATE_VECTOR_MIN_SCORE = 0.55
const DEFAULT_MAX_RELATED_EDGES = 5
const DEFAULT_EXTRACTOR_MAX_ITEMS = 10

export function vectorDimsForModel(model: string, explicit?: number): number {
	if (explicit && explicit > 0) return explicit
	const dims = KNOWN_EMBEDDING_DIMENSIONS[model]
	if (dims) return dims
	throw new Error(
		`Unknown embedding dimensions for model "${model}". Set embedding.dimensions explicitly.`,
	)
}

function resolveEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
		const envValue = process.env[envVar]
		if (!envValue) {
			throw new Error(`Environment variable ${envVar} is not set`)
		}
		return envValue
	})
}

function clampNumber(
	value: unknown,
	fallback: number,
	min?: number,
	max?: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback
	let next = value
	if (min !== undefined) next = Math.max(next, min)
	if (max !== undefined) next = Math.min(next, max)
	return next
}

function clampRatio(value: unknown, fallback: number): number {
	return clampNumber(value, fallback, 0, 1)
}

export function parseSupermemoryConfig(value: unknown): SupermemoryConfig {
	const cfg = (
		value && typeof value === "object" && !Array.isArray(value) ? value : {}
	) as Record<string, unknown>

	const embeddingRaw = (cfg.embedding ?? {}) as Record<string, unknown>

	const enabled = embeddingRaw.enabled !== false
	const provider =
		typeof embeddingRaw.provider === "string"
			? embeddingRaw.provider
			: DEFAULT_EMBEDDING_PROVIDER
	const model =
		typeof embeddingRaw.model === "string"
			? embeddingRaw.model
			: getDefaultEmbeddingModelForProvider(provider)
	const apiKey =
		typeof embeddingRaw.apiKey === "string"
			? resolveEnvVars(embeddingRaw.apiKey)
			: undefined
	const baseUrl =
		typeof embeddingRaw.baseUrl === "string"
			? resolveEnvVars(embeddingRaw.baseUrl)
			: undefined
	const dimensions =
		typeof embeddingRaw.dimensions === "number"
			? embeddingRaw.dimensions
			: undefined

	const dbPath = typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH

	return {
		embedding: { enabled, provider, model, apiKey, baseUrl, dimensions },
		autoCapture: cfg.autoCapture !== false,
		autoRecall: cfg.autoRecall !== false,
		profileFrequency: clampNumber(
			cfg.profileFrequency,
			DEFAULT_PROFILE_FREQUENCY,
			1,
			1000,
		),
		maxLongTermItems: clampNumber(
			cfg.maxLongTermItems,
			DEFAULT_MAX_LONG_TERM_ITEMS,
			1,
		),
		maxRecentItems: clampNumber(
			cfg.maxRecentItems,
			DEFAULT_MAX_RECENT_ITEMS,
			1,
		),
		recentWindowDays: clampNumber(
			cfg.recentWindowDays,
			DEFAULT_RECENT_WINDOW_DAYS,
			1,
		),
		profileScanLimit: clampNumber(
			cfg.profileScanLimit,
			DEFAULT_PROFILE_SCAN_LIMIT,
			1,
		),
		promptMemoryMaxChars: clampNumber(
			cfg.promptMemoryMaxChars,
			DEFAULT_PROMPT_MEMORY_MAX_CHARS,
			20,
			4000,
		),
		forgetExpiredIntervalMinutes: clampNumber(
			cfg.forgetExpiredIntervalMinutes,
			DEFAULT_FORGET_INTERVAL_MINUTES,
			1,
		),
		temporalDecayDays: clampNumber(
			cfg.temporalDecayDays,
			DEFAULT_TEMPORAL_DECAY_DAYS,
			1,
		),
		maxRecallResults: clampNumber(
			cfg.maxRecallResults,
			DEFAULT_MAX_RECALL_RESULTS,
			1,
			100,
		),
		vectorWeight: clampRatio(cfg.vectorWeight, DEFAULT_VECTOR_WEIGHT),
		textWeight: clampRatio(cfg.textWeight, DEFAULT_TEXT_WEIGHT),
		graphWeight: clampRatio(cfg.graphWeight, DEFAULT_GRAPH_WEIGHT),
		dbPath,
		captureMaxChars: clampNumber(
			cfg.captureMaxChars,
			DEFAULT_CAPTURE_MAX_CHARS,
			100,
			10000,
		),
		debug: cfg.debug === true,
		minScore: clampRatio(cfg.minScore, DEFAULT_MIN_SCORE),
		vectorMinScoreFactor: clampRatio(
			cfg.vectorMinScoreFactor,
			DEFAULT_VECTOR_MIN_SCORE_FACTOR,
		),
		graphSeedLimit: clampNumber(
			cfg.graphSeedLimit,
			DEFAULT_GRAPH_SEED_LIMIT,
			1,
			50,
		),
		graphHopDepth: clampNumber(
			cfg.graphHopDepth,
			DEFAULT_GRAPH_HOP_DEPTH,
			1,
			5,
		),
		mmrLambda: clampRatio(cfg.mmrLambda, DEFAULT_MMR_LAMBDA),
		autoRecallMaxMemories: clampNumber(
			cfg.autoRecallMaxMemories,
			DEFAULT_AUTO_RECALL_MAX_MEMORIES,
			1,
			50,
		),
		autoRecallMinScore: clampRatio(
			cfg.autoRecallMinScore,
			DEFAULT_AUTO_RECALL_MIN_SCORE,
		),
		nearDuplicateThreshold: clampRatio(
			cfg.nearDuplicateThreshold,
			DEFAULT_NEAR_DUPLICATE_THRESHOLD,
		),
		lexicalDuplicateThreshold: clampRatio(
			cfg.lexicalDuplicateThreshold,
			DEFAULT_LEXICAL_DUPLICATE_THRESHOLD,
		),
		updateVectorMinScore: clampRatio(
			cfg.updateVectorMinScore,
			DEFAULT_UPDATE_VECTOR_MIN_SCORE,
		),
		maxRelatedEdges: clampNumber(
			cfg.maxRelatedEdges,
			DEFAULT_MAX_RELATED_EDGES,
			0,
			20,
		),
		extractorMaxItems: clampNumber(
			cfg.extractorMaxItems,
			DEFAULT_EXTRACTOR_MAX_ITEMS,
			1,
			50,
		),
	}
}

export const supermemoryConfigSchema = {
	jsonSchema: {
		type: "object",
		additionalProperties: true,
		properties: {
			embedding: {
				type: "object",
				additionalProperties: true,
				properties: {
					enabled: { type: "boolean" },
					provider: { type: "string" },
					model: { type: "string" },
					apiKey: { type: "string" },
					baseUrl: { type: "string" },
					dimensions: { type: "number" },
				},
			},
			autoCapture: { type: "boolean" },
			autoRecall: { type: "boolean" },
			profileFrequency: { type: "number", minimum: 1, maximum: 1000 },
			maxLongTermItems: { type: "number", minimum: 1 },
			maxRecentItems: { type: "number", minimum: 1 },
			recentWindowDays: { type: "number", minimum: 1 },
			profileScanLimit: { type: "number", minimum: 1 },
			promptMemoryMaxChars: { type: "number", minimum: 20 },
			forgetExpiredIntervalMinutes: { type: "number", minimum: 1 },
			temporalDecayDays: { type: "number", minimum: 1 },
			maxRecallResults: { type: "number", minimum: 1, maximum: 100 },
			vectorWeight: { type: "number", minimum: 0, maximum: 1 },
			textWeight: { type: "number", minimum: 0, maximum: 1 },
			graphWeight: { type: "number", minimum: 0, maximum: 1 },
			dbPath: { type: "string" },
			captureMaxChars: { type: "number", minimum: 100, maximum: 10000 },
			debug: { type: "boolean" },
			minScore: { type: "number", minimum: 0, maximum: 1 },
			vectorMinScoreFactor: { type: "number", minimum: 0, maximum: 1 },
			graphSeedLimit: { type: "number", minimum: 1, maximum: 50 },
			graphHopDepth: { type: "number", minimum: 1, maximum: 5 },
			mmrLambda: { type: "number", minimum: 0, maximum: 1 },
			autoRecallMaxMemories: { type: "number", minimum: 1, maximum: 50 },
			autoRecallMinScore: { type: "number", minimum: 0, maximum: 1 },
			nearDuplicateThreshold: { type: "number", minimum: 0, maximum: 1 },
			lexicalDuplicateThreshold: { type: "number", minimum: 0, maximum: 1 },
			updateVectorMinScore: { type: "number", minimum: 0, maximum: 1 },
			maxRelatedEdges: { type: "number", minimum: 0, maximum: 20 },
			extractorMaxItems: { type: "number", minimum: 1, maximum: 50 },
		},
	},
	parse: parseSupermemoryConfig,
}
