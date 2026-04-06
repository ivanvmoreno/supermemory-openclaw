import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import plugin from "../index.ts"

type RegistrationMode = "full" | "setup-only" | "setup-runtime" | "cli-metadata"

type TestPluginApi = OpenClawPluginApi & {
	registrationMode?: RegistrationMode
	runtime: {
		config?: {
			loadConfig: () => Record<string, unknown>
			writeConfigFile: (cfg: Record<string, unknown>) => Promise<void>
		}
		subagent?: unknown
	}
}

type RegisteredService = {
	id: string
	start: (ctx: unknown) => void | Promise<void>
	stop?: (ctx: unknown) => void | Promise<void>
}

const CLI_COMMANDS = ["supermemory"]
const CLI_DESCRIPTORS = [
	{
		name: "supermemory",
		description: "Graph memory: search, profile, stats, wipe, configure",
		hasSubcommands: true,
	},
]

function noop(): void {}

function unexpected(name: string): (...args: unknown[]) => never {
	return (..._args: unknown[]) => {
		throw new Error(`Unexpected ${name}`)
	}
}

function createBaseApi(overrides: Partial<TestPluginApi>): TestPluginApi {
	return {
		id: "openclaw-memory-supermemory",
		name: "Memory (Supermemory Local)",
		description: "Test plugin API",
		source: "/tmp/openclaw-memory-supermemory/index.ts",
		registrationMode: "full",
		config: {},
		pluginConfig: {},
		runtime: {},
		logger: {
			info: noop,
			warn: noop,
		},
		registerTool: unexpected("registerTool"),
		registerHook: unexpected("registerHook"),
		registerHttpRoute: unexpected("registerHttpRoute"),
		registerChannel: unexpected("registerChannel"),
		registerGatewayMethod: unexpected("registerGatewayMethod"),
		registerCli: unexpected("registerCli"),
		registerReload: unexpected("registerReload"),
		registerNodeHostCommand: unexpected("registerNodeHostCommand"),
		registerSecurityAuditCollector: unexpected(
			"registerSecurityAuditCollector",
		),
		registerService: unexpected("registerService"),
		registerConfigMigration: unexpected("registerConfigMigration"),
		registerAutoEnableProbe: unexpected("registerAutoEnableProbe"),
		registerProvider: unexpected("registerProvider"),
		registerSpeechProvider: unexpected("registerSpeechProvider"),
		registerRealtimeTranscriptionProvider: unexpected(
			"registerRealtimeTranscriptionProvider",
		),
		registerRealtimeVoiceProvider: unexpected("registerRealtimeVoiceProvider"),
		registerMediaUnderstandingProvider: unexpected(
			"registerMediaUnderstandingProvider",
		),
		registerImageGenerationProvider: unexpected(
			"registerImageGenerationProvider",
		),
		registerVideoGenerationProvider: unexpected(
			"registerVideoGenerationProvider",
		),
		registerMusicGenerationProvider: unexpected(
			"registerMusicGenerationProvider",
		),
		registerWebFetchProvider: unexpected("registerWebFetchProvider"),
		registerWebSearchProvider: unexpected("registerWebSearchProvider"),
		registerInteractiveHandler: unexpected("registerInteractiveHandler"),
		onConversationBindingResolved: unexpected("onConversationBindingResolved"),
		registerCommand: unexpected("registerCommand"),
		registerContextEngine: unexpected("registerContextEngine"),
		registerMemoryPromptSection: unexpected("registerMemoryPromptSection"),
		registerMemoryFlushPlan: unexpected("registerMemoryFlushPlan"),
		registerMemoryRuntime: unexpected("registerMemoryRuntime"),
		registerMemoryEmbeddingProvider: unexpected(
			"registerMemoryEmbeddingProvider",
		),
		resolvePath: (input: string) => input,
		on: unexpected("on"),
		...overrides,
	} as TestPluginApi
}

test("cli-metadata registration stays metadata-only", () => {
	let resolvePathCalled = false
	let cliRegistration:
		| {
				commands?: string[]
				descriptors?: Array<{
					name: string
					description: string
					hasSubcommands: boolean
				}>
		  }
		| undefined

	const api = createBaseApi({
		registrationMode: "cli-metadata",
		pluginConfig: {
			embedding: {
				apiKey: "$" + "{SUPERMEMORY_TEST_MISSING_ENV_VAR}",
			},
		},
		registerCli: (_registrar, opts) => {
			cliRegistration = opts
		},
		resolvePath: (_input: string) => {
			resolvePathCalled = true
			return "/should-not-be-used"
		},
	})

	plugin.register(api as OpenClawPluginApi)

	assert.equal(resolvePathCalled, false)
	assert.deepEqual(cliRegistration, {
		commands: CLI_COMMANDS,
		descriptors: CLI_DESCRIPTORS,
	})
})

test("full registration wires the runtime without throwing", async (t) => {
	const tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "supermemory-registration-test-"),
	)
	t.after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	const toolNames: string[] = []
	const commandNames: string[] = []
	const hookNames: string[] = []
	const cliRegistrations: Array<{
		commands?: string[]
		descriptors?: Array<{
			name: string
			description: string
			hasSubcommands: boolean
		}>
	}> = []
	const services: RegisteredService[] = []
	let promptSectionRegistrations = 0
	let flushPlanRegistrations = 0
	let runtimeRegistrations = 0

	const api = createBaseApi({
		registrationMode: "full",
		pluginConfig: {
			dbPath: path.join(tmpDir, "supermemory.db"),
			autoCapture: false,
			autoRecall: false,
			embedding: {
				enabled: false,
			},
		},
		runtime: {
			config: {
				loadConfig: () => ({}),
				writeConfigFile: async () => {},
			},
			subagent: null,
		},
		registerTool: (_tool, opts) => {
			if (opts?.name) toolNames.push(opts.name)
		},
		registerCommand: (command) => {
			commandNames.push(command.name)
		},
		registerMemoryPromptSection: () => {
			promptSectionRegistrations++
		},
		registerMemoryFlushPlan: () => {
			flushPlanRegistrations++
		},
		registerMemoryRuntime: () => {
			runtimeRegistrations++
		},
		registerCli: (_registrar, opts) => {
			cliRegistrations.push(opts ?? {})
		},
		registerService: (service) => {
			services.push(service as RegisteredService)
		},
		on: (hookName) => {
			hookNames.push(hookName)
		},
	})

	plugin.register(api as OpenClawPluginApi)

	assert.deepEqual([...toolNames].sort(), [
		"memory_forget",
		"memory_profile",
		"memory_search",
		"memory_store",
	])
	assert.deepEqual([...commandNames].sort(), ["forget", "recall", "remember"])
	assert.deepEqual(hookNames, [])
	assert.equal(promptSectionRegistrations, 1)
	assert.equal(flushPlanRegistrations, 1)
	assert.equal(runtimeRegistrations, 1)
	assert.equal(cliRegistrations.length, 1)
	assert.deepEqual(cliRegistrations[0], {
		commands: CLI_COMMANDS,
		descriptors: CLI_DESCRIPTORS,
	})
	assert.equal(services.length, 1)

	await services[0]?.stop?.({
		config: {},
		stateDir: tmpDir,
		logger: api.logger,
	})
})
