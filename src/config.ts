import { homedir } from "node:os";
import { join } from "node:path";

export type EmbeddingConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
};

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "project",
  "instruction",
  "other",
] as const;

export type EntityExtractionMode = "pattern" | "llm";

export type RelationType = "updates" | "extends" | "derives";

export type SupermemoryConfig = {
  embedding: EmbeddingConfig;
  autoCapture: boolean;
  autoRecall: boolean;
  profileFrequency: number;
  entityExtraction: EntityExtractionMode;
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

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

function clampNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  let v = value;
  if (min !== undefined) v = Math.max(v, min);
  if (max !== undefined) v = Math.min(v, max);
  return v;
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
    profileFrequency: clampNumber(cfg.profileFrequency, DEFAULT_PROFILE_FREQUENCY, 1, 1000),
    entityExtraction: cfg.entityExtraction === "llm" ? "llm" : "pattern",
    forgetExpiredIntervalMinutes: clampNumber(
      cfg.forgetExpiredIntervalMinutes,
      DEFAULT_FORGET_INTERVAL_MINUTES,
      1,
    ),
    temporalDecayDays: clampNumber(cfg.temporalDecayDays, DEFAULT_TEMPORAL_DECAY_DAYS, 1),
    maxRecallResults: clampNumber(cfg.maxRecallResults, DEFAULT_MAX_RECALL_RESULTS, 1, 100),
    vectorWeight: clampNumber(cfg.vectorWeight, DEFAULT_VECTOR_WEIGHT, 0, 1),
    textWeight: clampNumber(cfg.textWeight, DEFAULT_TEXT_WEIGHT, 0, 1),
    graphWeight: clampNumber(cfg.graphWeight, DEFAULT_GRAPH_WEIGHT, 0, 1),
    dbPath,
    captureMaxChars: clampNumber(cfg.captureMaxChars, DEFAULT_CAPTURE_MAX_CHARS, 100, 10000),
    debug: cfg.debug === true,
  };
}
