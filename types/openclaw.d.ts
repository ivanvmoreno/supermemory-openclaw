// Type stubs for openclaw peer dependency.
// openclaw is loaded at runtime by the gateway; these declarations allow
// type-checking without installing the full openclaw package.

declare module "openclaw/plugin-sdk" {
	export interface OpenClawPluginApi {
		pluginConfig: unknown
		logger: {
			info: (msg: string) => void
			warn: (msg: string) => void
			error: (msg: string, ...args: unknown[]) => void
			debug: (msg: string) => void
		}
		resolvePath(input: string): string
		registerTool(tool: any, options?: any): void
		registerCommand(command: any): void
		registerCli(handler: any, options?: any): void
		registerService(service: any): void
		on(event: string, handler: (...args: any[]) => any): void
		registerMemoryPromptSection(builder: (params: { availableTools: Set<string>; citationsMode?: string }) => string[]): void
		registerMemoryFlushPlan(resolver: (params: { cfg?: any; nowMs?: number }) => any | null): void
		registerMemoryRuntime(runtime: any): void
		registerMemoryEmbeddingProvider(adapter: any): void
		runtime: {
			config: {
				loadConfig: () => Record<string, unknown>
				writeConfigFile: (cfg: Record<string, unknown>) => Promise<void>
			}
		}
	}
}
