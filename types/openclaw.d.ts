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
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		registerTool(tool: any, options?: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		registerCommand(command: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		registerCli(handler: any, options?: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		registerService(service: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		on(event: string, handler: (...args: any[]) => any): void
		// Memory plugin exclusive slot methods
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		registerMemoryPromptSection(builder: (params: { availableTools: Set<string>; citationsMode?: string }) => string[]): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		registerMemoryFlushPlan(resolver: (params: { cfg?: any; nowMs?: number }) => any | null): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		registerMemoryRuntime(runtime: any): void
		// biome-ignore lint/suspicious/noExplicitAny: openclaw SDK does not ship standalone types
		registerMemoryEmbeddingProvider(adapter: any): void
	}
}
