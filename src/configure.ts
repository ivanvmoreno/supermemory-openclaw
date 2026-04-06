import * as p from "@clack/prompts"
import { homedir } from "node:os"
import { join } from "node:path"

type OpenClawConfig = Record<string, unknown>

export type ConfigDeps = {
  loadConfig: () => OpenClawConfig
  writeConfigFile: (cfg: OpenClawConfig) => Promise<void>
}

const PLUGIN_ID = "openclaw-memory-supermemory"
const DEFAULT_DB_PATH = join(homedir(), ".openclaw", "memory", "supermemory.db")
const DEFAULT_EMBEDDING_PROVIDER = "ollama"
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text"

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
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

  const enablePlugin = await p.confirm({
    message: "Enable the Supermemory plugin?",
    initialValue: true,
  })
  if (p.isCancel(enablePlugin)) {
    p.cancel("Setup cancelled.")
    return
  }

  const autoCapture = await p.confirm({
    message: "Enable auto-capture? (extract memories from conversations automatically)",
    initialValue: true,
  })
  if (p.isCancel(autoCapture)) {
    p.cancel("Setup cancelled.")
    return
  }

  const autoRecall = await p.confirm({
    message: "Enable auto-recall? (inject relevant memories into prompts automatically)",
    initialValue: true,
  })
  if (p.isCancel(autoRecall)) {
    p.cancel("Setup cancelled.")
    return
  }

  const embeddingEnabled = await p.confirm({
    message: "Enable vector embeddings? (required for semantic search and vector deduplication)",
    initialValue: true,
  })
  if (p.isCancel(embeddingEnabled)) {
    p.cancel("Setup cancelled.")
    return
  }

  let embeddingProvider: string | undefined
  let embeddingModel: string | undefined
  let embeddingApiKey: string | undefined
  let embeddingBaseUrl: string | undefined

  if (embeddingEnabled) {
    const providerInput = await p.text({
      message: "Embedding provider:",
      placeholder: DEFAULT_EMBEDDING_PROVIDER,
      initialValue: DEFAULT_EMBEDDING_PROVIDER,
    })
    if (p.isCancel(providerInput)) {
      p.cancel("Setup cancelled.")
      return
    }
    embeddingProvider = ((providerInput as string) || DEFAULT_EMBEDDING_PROVIDER).trim()

    const modelInput = await p.text({
      message: "Embedding model:",
      placeholder: DEFAULT_EMBEDDING_MODEL,
      initialValue: DEFAULT_EMBEDDING_MODEL,
    })
    if (p.isCancel(modelInput)) {
      p.cancel("Setup cancelled.")
      return
    }
    embeddingModel = ((modelInput as string) || DEFAULT_EMBEDDING_MODEL).trim()

    const isOllama =
      embeddingProvider === "ollama" || embeddingProvider.includes("localhost")
    if (!isOllama) {
      const apiKeyInput = await p.password({
        message: "Embedding API key (leave blank to skip):",
      })
      if (p.isCancel(apiKeyInput)) {
        p.cancel("Setup cancelled.")
        return
      }
      const trimmed = ((apiKeyInput as string) ?? "").trim()
      if (trimmed) embeddingApiKey = trimmed
    }

    const baseUrlInput = await p.text({
      message: "Custom embedding base URL (optional, press Enter to skip):",
      placeholder: isOllama ? "http://localhost:11434/v1" : "",
    })
    if (p.isCancel(baseUrlInput)) {
      p.cancel("Setup cancelled.")
      return
    }
    const trimmedBaseUrl = ((baseUrlInput as string) ?? "").trim()
    if (trimmedBaseUrl) embeddingBaseUrl = trimmedBaseUrl
  }

  const dbPathInput = await p.text({
    message: "Database path (press Enter to use default):",
    placeholder: DEFAULT_DB_PATH,
  })
  if (p.isCancel(dbPathInput)) {
    p.cancel("Setup cancelled.")
    return
  }
  const dbPath = ((dbPathInput as string) ?? "").trim() || undefined

  const existingCfg = deps.loadConfig()
  const existingEntry = getSupermemoryPluginEntry(existingCfg)

  const embeddingConfig: Record<string, unknown> = {
    ...asObject(existingEntry.config.embedding),
    enabled: embeddingEnabled,
    ...(embeddingProvider !== undefined ? { provider: embeddingProvider } : {}),
    ...(embeddingModel !== undefined ? { model: embeddingModel } : {}),
    ...(embeddingApiKey !== undefined ? { apiKey: embeddingApiKey } : {}),
    ...(embeddingBaseUrl !== undefined ? { baseUrl: embeddingBaseUrl } : {}),
  }

  const nextConfig: Record<string, unknown> = {
    ...existingEntry.config,
    autoCapture,
    autoRecall,
    embedding: embeddingConfig,
    ...(dbPath !== undefined ? { dbPath } : {}),
  }

  const nextCfg = setSupermemoryPluginEntry(existingCfg, nextConfig, enablePlugin as boolean)
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
    console.log("Supermemory is not configured. Run: openclaw supermemory configure")
    return
  }

  const enabled = entry.enabled !== false
  const embedding = asObject(config.embedding)

  const lines = [
    `  Enabled:      ${enabled ? "yes" : "no"}`,
    `  Auto-capture: ${config.autoCapture !== false ? "yes" : "no"}`,
    `  Auto-recall:  ${config.autoRecall !== false ? "yes" : "no"}`,
    `  DB path:      ${(config.dbPath as string) ?? DEFAULT_DB_PATH}`,
    "",
    `  Embedding enabled:  ${embedding.enabled !== false ? "yes" : "no"}`,
    `  Embedding provider: ${(embedding.provider as string) ?? DEFAULT_EMBEDDING_PROVIDER}`,
    `  Embedding model:    ${(embedding.model as string) ?? DEFAULT_EMBEDDING_MODEL}`,
    ...(embedding.baseUrl ? [`  Embedding base URL: ${embedding.baseUrl}`] : []),
    `  Embedding API key:  ${embedding.apiKey ? "***" : "(not set)"}`,
  ]

  console.log("Supermemory status:\n")
  console.log(lines.join("\n"))
}

type Commander = any

export function registerSupermemoryConfigure(mem: Commander, deps: ConfigDeps): void {
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
