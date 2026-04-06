export type EmbeddingProviderKind = "ollama" | "openai-compatible"

export type EmbeddingModelSpec = {
	id: string
	dimensions: number
	hint?: string
}

export type EmbeddingProviderSpec = {
	id: string
	label: string
	hint: string
	kind: EmbeddingProviderKind
	defaultModel: string
	requiresApiKey: boolean
	baseUrlPlaceholder?: string
	models: readonly EmbeddingModelSpec[]
}

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
export const DEFAULT_EMBEDDING_PROVIDER = "ollama"
export const DEFAULT_EMBEDDING_MODEL = "embeddinggemma"
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"

export const OLLAMA_EMBEDDING_MODELS: readonly EmbeddingModelSpec[] = [
	{
		id: DEFAULT_EMBEDDING_MODEL,
		dimensions: 768,
		hint: "Recommended local default",
	},
	{
		id: "qwen3-embedding",
		dimensions: 4096,
		hint: "Long-context multilingual retrieval",
	},
	{
		id: "bge-m3",
		dimensions: 1024,
		hint: "Popular multilingual heavy-duty option",
	},
	{
		id: "all-minilm",
		dimensions: 384,
		hint: "Fast lightweight model",
	},
	{
		id: "nomic-embed-text",
		dimensions: 768,
		hint: "Stable legacy default",
	},
	{
		id: "snowflake-arctic-embed2",
		dimensions: 1024,
		hint: "Frontier multilingual model",
	},
	{
		id: "mxbai-embed-large",
		dimensions: 1024,
		hint: "High-quality large encoder",
	},
	{
		id: "snowflake-arctic-embed",
		dimensions: 1024,
		hint: "Legacy Snowflake encoder",
	},
]

export const OPENAI_EMBEDDING_MODELS: readonly EmbeddingModelSpec[] = [
	{
		id: DEFAULT_OPENAI_EMBEDDING_MODEL,
		dimensions: 1536,
		hint: "Default cost/performance choice",
	},
	{
		id: "text-embedding-3-large",
		dimensions: 3072,
		hint: "Highest-quality OpenAI option",
	},
]

export const EMBEDDING_PROVIDER_SPECS: readonly EmbeddingProviderSpec[] = [
	{
		id: DEFAULT_EMBEDDING_PROVIDER,
		label: "Ollama",
		hint: "Local embeddings via Ollama",
		kind: "ollama",
		defaultModel: DEFAULT_EMBEDDING_MODEL,
		requiresApiKey: false,
		baseUrlPlaceholder: DEFAULT_OLLAMA_BASE_URL,
		models: OLLAMA_EMBEDDING_MODELS,
	},
	{
		id: "openai",
		label: "OpenAI",
		hint: "Hosted embeddings via OpenAI",
		kind: "openai-compatible",
		defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
		requiresApiKey: true,
		baseUrlPlaceholder: DEFAULT_OPENAI_BASE_URL,
		models: OPENAI_EMBEDDING_MODELS,
	},
]

const knownEmbeddingDimensions = new Map<string, number>()
for (const provider of EMBEDDING_PROVIDER_SPECS) {
	for (const model of provider.models) {
		if (!knownEmbeddingDimensions.has(model.id)) {
			knownEmbeddingDimensions.set(model.id, model.dimensions)
		}
	}
}

export const KNOWN_EMBEDDING_DIMENSIONS = Object.freeze(
	Object.fromEntries(knownEmbeddingDimensions),
) as Readonly<Record<string, number>>

function normalizeProvider(provider: string): string {
	return provider.trim().toLowerCase()
}

export function getEmbeddingProviderSpec(
	provider: string | undefined,
): EmbeddingProviderSpec | undefined {
	if (!provider) return undefined
	const normalized = normalizeProvider(provider)
	return EMBEDDING_PROVIDER_SPECS.find(
		(candidate) => normalizeProvider(candidate.id) === normalized,
	)
}

export function getEmbeddingProviderKind(
	provider: string,
): EmbeddingProviderKind {
	return getEmbeddingProviderSpec(provider)?.kind ?? "openai-compatible"
}

export function isOllamaProvider(provider: string): boolean {
	return getEmbeddingProviderKind(provider) === "ollama"
}

export function requiresEmbeddingApiKey(provider: string): boolean {
	return getEmbeddingProviderSpec(provider)?.requiresApiKey ?? true
}

export function getSuggestedEmbeddingModels(
	provider: string,
): readonly EmbeddingModelSpec[] {
	return (
		getEmbeddingProviderSpec(provider)?.models ??
		(getEmbeddingProviderKind(provider) === "ollama"
			? OLLAMA_EMBEDDING_MODELS
			: OPENAI_EMBEDDING_MODELS)
	)
}

export function getDefaultEmbeddingModelForProvider(provider: string): string {
	return (
		getEmbeddingProviderSpec(provider)?.defaultModel ??
		(getEmbeddingProviderKind(provider) === "ollama"
			? DEFAULT_EMBEDDING_MODEL
			: DEFAULT_OPENAI_EMBEDDING_MODEL)
	)
}

export function getEmbeddingBaseUrlPlaceholder(
	provider: string,
): string | undefined {
	return getEmbeddingProviderSpec(provider)?.baseUrlPlaceholder
}

export function sharesEmbeddingModelCatalog(
	left: string | undefined,
	right: string | undefined,
): boolean {
	if (!left || !right) return false
	if (normalizeProvider(left) === normalizeProvider(right)) return true
	return getEmbeddingProviderKind(left) === getEmbeddingProviderKind(right)
}
