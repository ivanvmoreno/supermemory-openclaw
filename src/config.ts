import { homedir } from "node:os";
import { join } from "node:path";

export type EmbeddingConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
};

export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MEMORY_TYPES = [
  "fact",
  "preference",
  "episode",
] as const;

export type CaptureMode = "extract" | "off";

export type RelationType = "updates" | "related";

export type SupermemoryConfig = {
  embedding: EmbeddingConfig;
  autoCapture: boolean;
  autoRecall: boolean;
  captureMode: CaptureMode;
  profileFrequency: number;
  maxLongTermItems: number;
  maxRecentItems: number;
  recentWindowDays: number;
  profileScanLimit: number;
  promptMemoryMaxChars: number;
  forgetExpiredIntervalMinutes: number;
  temporalDecayDays: number;
  maxRecallResults: number;
  vectorWeight: number;
  textWeight: number;
  graphWeight: number;
  dbPath: string;
  captureMaxChars: number;
  debug: boolean;
};

const DEFAULT_EMBEDDING_PROVIDER = "ollama";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "supermemory.db");
const DEFAULT_PROFILE_FREQUENCY = 50;
const DEFAULT_MAX_LONG_TERM_ITEMS = 20;
const DEFAULT_MAX_RECENT_ITEMS = 10;
const DEFAULT_RECENT_WINDOW_DAYS = 7;
const DEFAULT_PROFILE_SCAN_LIMIT = 1000;
const DEFAULT_PROMPT_MEMORY_MAX_CHARS = 500;
const DEFAULT_FORGET_INTERVAL_MINUTES = 60;
const DEFAULT_TEMPORAL_DECAY_DAYS = 90;
const DEFAULT_MAX_RECALL_RESULTS = 10;
const DEFAULT_VECTOR_WEIGHT = 0.5;
const DEFAULT_TEXT_WEIGHT = 0.3;
const DEFAULT_GRAPH_WEIGHT = 0.2;
const DEFAULT_CAPTURE_MAX_CHARS = 2000;

const KNOWN_EMBEDDING_DIMENSIONS: Record<string, number> = {
  "nomic-embed-text": 768,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "snowflake-arctic-embed": 1024,
};

export function vectorDimsForModel(model: string, explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  const dims = KNOWN_EMBEDDING_DIMENSIONS[model];
  if (dims) return dims;
  throw new Error(
    `Unknown embedding dimensions for model "${model}". Set embedding.dimensions explicitly.`,
  );
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function clampNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  let next = value;
  if (min !== undefined) next = Math.max(next, min);
  if (max !== undefined) next = Math.min(next, max);
  return next;
}

function clampRatio(value: unknown, fallback: number): number {
  return clampNumber(value, fallback, 0, 1);
}

export function parseSupermemoryConfig(value: unknown): SupermemoryConfig {
  const cfg = (value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {}) as Record<string, unknown>;

  const embeddingRaw = (cfg.embedding ?? {}) as Record<string, unknown>;

  const provider =
    typeof embeddingRaw.provider === "string" ? embeddingRaw.provider : DEFAULT_EMBEDDING_PROVIDER;
  const model =
    typeof embeddingRaw.model === "string" ? embeddingRaw.model : DEFAULT_EMBEDDING_MODEL;
  const apiKey =
    typeof embeddingRaw.apiKey === "string" ? resolveEnvVars(embeddingRaw.apiKey) : undefined;
  const baseUrl =
    typeof embeddingRaw.baseUrl === "string" ? resolveEnvVars(embeddingRaw.baseUrl) : undefined;
  const dimensions =
    typeof embeddingRaw.dimensions === "number" ? embeddingRaw.dimensions : undefined;

  const dbPath = typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH;

  return {
    embedding: { provider, model, apiKey, baseUrl, dimensions },
    autoCapture: cfg.autoCapture !== false,
    autoRecall: cfg.autoRecall !== false,
    captureMode: cfg.captureMode === "off" ? "off" : "extract",
    profileFrequency: clampNumber(cfg.profileFrequency, DEFAULT_PROFILE_FREQUENCY, 1, 1000),
    maxLongTermItems: clampNumber(cfg.maxLongTermItems, DEFAULT_MAX_LONG_TERM_ITEMS, 1),
    maxRecentItems: clampNumber(cfg.maxRecentItems, DEFAULT_MAX_RECENT_ITEMS, 1),
    recentWindowDays: clampNumber(cfg.recentWindowDays, DEFAULT_RECENT_WINDOW_DAYS, 1),
    profileScanLimit: clampNumber(cfg.profileScanLimit, DEFAULT_PROFILE_SCAN_LIMIT, 1),
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
    temporalDecayDays: clampNumber(cfg.temporalDecayDays, DEFAULT_TEMPORAL_DECAY_DAYS, 1),
    maxRecallResults: clampNumber(cfg.maxRecallResults, DEFAULT_MAX_RECALL_RESULTS, 1, 100),
    vectorWeight: clampRatio(cfg.vectorWeight, DEFAULT_VECTOR_WEIGHT),
    textWeight: clampRatio(cfg.textWeight, DEFAULT_TEXT_WEIGHT),
    graphWeight: clampRatio(cfg.graphWeight, DEFAULT_GRAPH_WEIGHT),
    dbPath,
    captureMaxChars: clampNumber(cfg.captureMaxChars, DEFAULT_CAPTURE_MAX_CHARS, 100, 10000),
    debug: cfg.debug === true,
  };
}
