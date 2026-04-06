import { homedir } from "node:os"
import { join } from "node:path"
import * as p from "@clack/prompts"
import {
	DEFAULT_EMBEDDING_PROVIDER,
	EMBEDDING_PROVIDER_SPECS,
	getDefaultEmbeddingModelForProvider,
	getEmbeddingBaseUrlPlaceholder,
	getSuggestedEmbeddingModels,
	requiresEmbeddingApiKey,
	sharesEmbeddingModelCatalog,
} from "./embedding-catalog.ts"

type OpenClawConfig = Record<string, unknown>

export type ConfigDeps = {
	loadConfig: () => OpenClawConfig
	writeConfigFile: (cfg: OpenClawConfig) => Promise<void>
}

const PLUGIN_ID = "openclaw-memory-supermemory"
const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "supermemory.db")
const CUSTOM_SELECT_VALUE = "__custom__"

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {}
	return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed ? trimmed : undefined
}

function withCustomOption(
	options: p.SelectOption<string>[],
	currentValue: string | undefined,
	currentHint: string,
): p.SelectOption<string>[] {
	const nextOptions = [...options]
	if (
		currentValue &&
		!nextOptions.some((option) => option.value === currentValue)
	) {
		nextOptions.push({
			value: currentValue,
			label: currentValue,
			hint: currentHint,
		})
	}
	nextOptions.push({
		value: CUSTOM_SELECT_VALUE,
		label: "Custom",
		hint: "Enter a custom value",
	})
	return nextOptions
}

function getEmbeddingProviderOptions(
	currentProvider: string | undefined,
): p.SelectOption<string>[] {
	return withCustomOption(
		EMBEDDING_PROVIDER_SPECS.map((provider) => ({
			value: provider.id,
			label: provider.label,
			hint: provider.hint,
		})),
		currentProvider,
		"Current value",
	)
}

function getEmbeddingModelOptions(
	provider: string,
	currentModel: string | undefined,
): p.SelectOption<string>[] {
	return withCustomOption(
		getSuggestedEmbeddingModels(provider).map((model) => ({
			value: model.id,
			label: model.id,
			hint: `${model.dimensions} dims`,
		})),
		currentModel,
		"Current value",
	)
}

export function getSupermemoryPluginEntry(cfg: OpenClawConfig): {
	enabled?: boolean
	config: Record<string, unknown>
} {
	const root = asObject(cfg)
	const plugins = asObject(root.plugins)
	const entries = asObject(plugins.entries)
	const entry = asObject(entries[PLUGIN_ID])
	const config = asObject(entry.config)
	return {
		enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
		config,
	}
}

export function setSupermemoryPluginEntry(
	cfg: OpenClawConfig,
	config: Record<string, unknown>,
	enabled = true,
): OpenClawConfig {
	const root = asObject(cfg)
	const plugins = asObject(root.plugins)
	const entries = asObject(plugins.entries)
	const existingEntry = asObject(entries[PLUGIN_ID])
	const nextEntries = {
		...entries,
		[PLUGIN_ID]: {
			...existingEntry,
			enabled,
			config: {
				...asObject(existingEntry.config),
				...config,
			},
		},
	}
	return {
		...root,
		plugins: {
			...plugins,
			entries: nextEntries,
		},
	} as OpenClawConfig
}

export async function runSupermemoryConfigure(deps: ConfigDeps): Promise<void> {
	p.intro("Supermemory setup")

	const existingCfg = deps.loadConfig()
	const existingEntry = getSupermemoryPluginEntry(existingCfg)
	const existingEmbedding = asObject(existingEntry.config.embedding)
	const currentProvider = asString(existingEmbedding.provider)
	const currentModel = asString(existingEmbedding.model)
	const currentApiKey = asString(existingEmbedding.apiKey)
	const currentBaseUrl = asString(existingEmbedding.baseUrl)
	const currentDbPath = asString(existingEntry.config.dbPath)

	const enablePlugin = await p.confirm({
		message: "Enable the Supermemory plugin?",
		initialValue: existingEntry.enabled !== false,
	})
	if (p.isCancel(enablePlugin)) {
		p.cancel("Setup cancelled.")
		return
	}

	const autoCapture = await p.confirm({
		message:
			"Enable auto-capture? (extract memories from conversations automatically)",
		initialValue: existingEntry.config.autoCapture !== false,
	})
	if (p.isCancel(autoCapture)) {
		p.cancel("Setup cancelled.")
		return
	}

	const autoRecall = await p.confirm({
		message:
			"Enable auto-recall? (inject relevant memories into prompts automatically)",
		initialValue: existingEntry.config.autoRecall !== false,
	})
	if (p.isCancel(autoRecall)) {
		p.cancel("Setup cancelled.")
		return
	}

	const embeddingEnabled = await p.confirm({
		message:
			"Use embeddings? (required for semantic search and vector deduplication)",
		initialValue: existingEmbedding.enabled !== false,
	})
	if (p.isCancel(embeddingEnabled)) {
		p.cancel("Setup cancelled.")
		return
	}

	let embeddingProvider = currentProvider
	let embeddingModel = currentModel
	let embeddingApiKey = currentApiKey
	let embeddingBaseUrl = currentBaseUrl

	if (embeddingEnabled) {
		const providerOptions = getEmbeddingProviderOptions(currentProvider)
		const providerSelection = await p.select({
			message: "Embedding provider:",
			options: providerOptions,
			initialValue:
				currentProvider &&
				providerOptions.some((option) => option.value === currentProvider)
					? currentProvider
					: DEFAULT_EMBEDDING_PROVIDER,
		})
		if (p.isCancel(providerSelection)) {
			p.cancel("Setup cancelled.")
			return
		}
		if (providerSelection === CUSTOM_SELECT_VALUE) {
			const providerInput = await p.text({
				message: "Custom embedding provider:",
				placeholder: currentProvider ?? DEFAULT_EMBEDDING_PROVIDER,
				initialValue: currentProvider ?? "",
				validate: (value) =>
					value.trim() ? undefined : "Provider is required",
			})
			if (p.isCancel(providerInput)) {
				p.cancel("Setup cancelled.")
				return
			}
			embeddingProvider = (providerInput as string).trim()
		} else {
			embeddingProvider = providerSelection as string
		}

		const initialModel = sharesEmbeddingModelCatalog(
			currentProvider,
			embeddingProvider,
		)
			? currentModel
			: undefined
		const modelOptions = getEmbeddingModelOptions(
			embeddingProvider,
			initialModel,
		)
		const modelSelection = await p.select({
			message: "Embedding model:",
			options: modelOptions,
			initialValue:
				initialModel &&
				modelOptions.some((option) => option.value === initialModel)
					? initialModel
					: getDefaultEmbeddingModelForProvider(embeddingProvider),
		})
		if (p.isCancel(modelSelection)) {
			p.cancel("Setup cancelled.")
			return
		}
		if (modelSelection === CUSTOM_SELECT_VALUE) {
			const modelInput = await p.text({
				message: "Custom embedding model:",
				placeholder:
					initialModel ??
					getDefaultEmbeddingModelForProvider(embeddingProvider),
				initialValue: initialModel ?? "",
				validate: (value) => (value.trim() ? undefined : "Model is required"),
			})
			if (p.isCancel(modelInput)) {
				p.cancel("Setup cancelled.")
				return
			}
			embeddingModel = (modelInput as string).trim()
		} else {
			embeddingModel = modelSelection as string
		}

		const needsApiKey = requiresEmbeddingApiKey(embeddingProvider)
		if (!needsApiKey) {
			embeddingApiKey = undefined
		} else {
			const apiKeyInput = await p.password({
				message: currentApiKey
					? "Embedding API key (press Enter to keep current value):"
					: "Embedding API key (leave blank to skip):",
			})
			if (p.isCancel(apiKeyInput)) {
				p.cancel("Setup cancelled.")
				return
			}
			const trimmed = ((apiKeyInput as string) ?? "").trim()
			if (trimmed) embeddingApiKey = trimmed
		}

		const initialBaseUrl = sharesEmbeddingModelCatalog(
			currentProvider,
			embeddingProvider,
		)
			? currentBaseUrl
			: undefined
		const baseUrlInput = await p.text({
			message: initialBaseUrl
				? "Custom embedding base URL (optional, clear to remove):"
				: "Custom embedding base URL (optional, press Enter to skip):",
			placeholder: getEmbeddingBaseUrlPlaceholder(embeddingProvider) ?? "",
			initialValue: initialBaseUrl ?? "",
		})
		if (p.isCancel(baseUrlInput)) {
			p.cancel("Setup cancelled.")
			return
		}
		const trimmedBaseUrl = ((baseUrlInput as string) ?? "").trim()
		embeddingBaseUrl = trimmedBaseUrl || undefined
	}

	const dbPathInput = await p.text({
		message: currentDbPath
			? "Database path (clear to use default):"
			: "Database path (press Enter to use default):",
		placeholder: DEFAULT_DB_PATH,
		initialValue: currentDbPath ?? "",
	})
	if (p.isCancel(dbPathInput)) {
		p.cancel("Setup cancelled.")
		return
	}
	const dbPath = ((dbPathInput as string) ?? "").trim() || undefined

	const embeddingConfig: Record<string, unknown> = {
		...asObject(existingEntry.config.embedding),
		enabled: embeddingEnabled,
	}
	if (embeddingProvider !== undefined)
		embeddingConfig.provider = embeddingProvider
	if (embeddingModel !== undefined) embeddingConfig.model = embeddingModel
	if (embeddingApiKey !== undefined) embeddingConfig.apiKey = embeddingApiKey
	if (embeddingBaseUrl !== undefined) embeddingConfig.baseUrl = embeddingBaseUrl
	else delete embeddingConfig.baseUrl

	const nextConfig: Record<string, unknown> = {
		...existingEntry.config,
		autoCapture,
		autoRecall,
		embedding: embeddingConfig,
	}
	if (dbPath !== undefined) nextConfig.dbPath = dbPath
	else delete nextConfig.dbPath

	const nextCfg = setSupermemoryPluginEntry(
		existingCfg,
		nextConfig,
		enablePlugin as boolean,
	)
	await deps.writeConfigFile(nextCfg)

	p.note(
		[
			`Plugin:       ${(enablePlugin as boolean) ? "enabled" : "disabled"}`,
			`Auto-capture: ${(autoCapture as boolean) ? "yes" : "no"}`,
			`Auto-recall:  ${(autoRecall as boolean) ? "yes" : "no"}`,
			`Embeddings:   ${(embeddingEnabled as boolean) ? "yes" : "no"}`,
			...(embeddingEnabled
				? [
						`  Provider:   ${embeddingProvider}`,
						`  Model:      ${embeddingModel}`,
						...(embeddingApiKey ? ["  API key:    ***"] : []),
						...(embeddingBaseUrl ? [`  Base URL:   ${embeddingBaseUrl}`] : []),
					]
				: []),
			`DB path:      ${dbPath ?? DEFAULT_DB_PATH}`,
		].join("\n"),
		"Supermemory configuration saved",
	)
	p.outro("Restart the gateway to apply changes.")
}

export function showSupermemoryStatus(deps: ConfigDeps): void {
	const cfg = deps.loadConfig()
	const entry = getSupermemoryPluginEntry(cfg)
	const config = entry.config

	if (entry.enabled === undefined && Object.keys(config).length === 0) {
		console.log(
			"Supermemory is not configured. Run: openclaw supermemory configure",
		)
		return
	}

	const enabled = entry.enabled !== false
	const embedding = asObject(config.embedding)
	const embeddingProvider =
		(embedding.provider as string) ?? DEFAULT_EMBEDDING_PROVIDER
	const embeddingModel =
		(embedding.model as string) ??
		getDefaultEmbeddingModelForProvider(embeddingProvider)

	const lines = [
		`  Enabled:      ${enabled ? "yes" : "no"}`,
		`  Auto-capture: ${config.autoCapture !== false ? "yes" : "no"}`,
		`  Auto-recall:  ${config.autoRecall !== false ? "yes" : "no"}`,
		`  DB path:      ${(config.dbPath as string) ?? DEFAULT_DB_PATH}`,
		"",
		`  Embedding enabled:  ${embedding.enabled !== false ? "yes" : "no"}`,
		`  Embedding provider: ${embeddingProvider}`,
		`  Embedding model:    ${embeddingModel}`,
		...(embedding.baseUrl
			? [`  Embedding base URL: ${embedding.baseUrl}`]
			: []),
		`  Embedding API key:  ${embedding.apiKey ? "***" : "(not set)"}`,
	]

	console.log("Supermemory status:\n")
	console.log(lines.join("\n"))
}

type Commander = any

export function registerSupermemoryConfigure(
	mem: Commander,
	deps: ConfigDeps,
): void {
	mem
		.command("configure")
		.description("Interactive setup for Supermemory")
		.action(async () => {
			await runSupermemoryConfigure(deps)
		})

	mem
		.command("status")
		.description("Show current Supermemory configuration")
		.action(() => {
			showSupermemoryStatus(deps)
		})
}
