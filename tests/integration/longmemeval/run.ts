import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	type EmbeddingConfig,
	parseSupermemoryConfig,
	vectorDimsForModel,
} from "../../../src/config.ts"
import { MemoryDB } from "../../../src/db.ts"
import { createEmbeddingProvider } from "../../../src/embeddings.ts"
import { processNewMemory } from "../../../src/graph-engine.ts"
import { buildUserProfile } from "../../../src/profile-builder.ts"

type LongMemEvalTurn = {
	role: string
	content: string
	has_answer?: boolean
}

type LongMemEvalEntry = {
	question_id: string
	question_type: string
	question: string
	answer: string | number
	question_date: string
	haystack_dates: string[]
	haystack_session_ids: string[]
	haystack_sessions: LongMemEvalTurn[][]
	answer_session_ids: string[]
}

const SUPPORTED_PRESETS = ["smoke", "full"] as const

type EvalPreset = (typeof SUPPORTED_PRESETS)[number]

type CliOptions = {
	dataFile?: string
	profile: string
	preset: EvalPreset
	limit?: number
	keepProfile: boolean
	officialRepo?: string
	runOfficialEval: boolean
	help: boolean
}

type ResolvedOptions = CliOptions & {
	sourceStateDir: string
	dataFile: string
	outputDir: string
	model: string
	embedding: EmbeddingConfig
}

type SourceConfig = {
	agents?: {
		defaults?: {
			model?: {
				primary?: string
			}
		}
	}
	plugins?: {
		entries?: Record<
			string,
			{ enabled?: boolean; config?: Record<string, unknown> }
		>
	}
}

type AuthProfiles = {
	profiles?: Record<string, { provider?: string; type?: string; key?: string }>
}

type ImportMemory = {
	text: string
	timestampMs: number
}

type RunResult = {
	question_id: string
	question_type: string
	question: string
	answer: string | number
	question_date: string
	hypothesis: string
	imported_memories: number
	prompt_tokens?: number
	completion_tokens?: number
}

const FALLBACK_QA_MODEL = "openai/gpt-4o"
const FALLBACK_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
const FALLBACK_OLLAMA_EMBEDDING_MODEL = "embeddinggemma"
const FALLBACK_SOURCE_STATE_DIR = "~/.openclaw"
const FALLBACK_MAX_RECALL_RESULTS = 8
const FALLBACK_OFFICIAL_REPO = "/tmp/LongMemEval"
const FALLBACK_OFFICIAL_METRIC_MODEL = "gpt-4o"
const DOTENV_FILE_NAMES = [".env.local", ".env"] as const
const RUNNER_ENV = {
	sourceStateDir: "LONGMEMEVAL_SOURCE_STATE_DIR",
	officialRepo: "LONGMEMEVAL_OFFICIAL_REPO",
} as const
const EMBEDDING_API_KEY_ENV = "LONGMEMEVAL_EMBEDDING_API_KEY"
const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
)
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json")
const BUNDLED_DATA_FILE = join(
	REPO_ROOT,
	"tests",
	"integration",
	"longmemeval",
	"fixtures",
	"oracle.json",
)
const RUN_ROOT = join(REPO_ROOT, ".tmp", "tests", "integration", "longmemeval")

async function main(): Promise<void> {
	loadRunnerEnvFiles()
	const cli = parseCli(process.argv.slice(2))
	if (cli.help) {
		printHelp()
		return
	}

	const options = await resolveOptions(cli)
	if (options.embedding.apiKey) {
		process.env[EMBEDDING_API_KEY_ENV] = options.embedding.apiKey
	}
	await mkdir(options.outputDir, { recursive: true })

	const entries = await loadEntries(options)
	if (entries.length === 0) {
		throw new Error("No LongMemEval entries matched the requested filters.")
	}

	const profileRoot = resolveProfileRoot(options.profile)
	await prepareEvalProfile(options, profileRoot)

	const results: RunResult[] = []
	for (const entry of entries) {
		const imported_memories = await importBenchmarkEntry(
			options,
			entry,
			profileRoot,
		)
		const response = await askOpenClaw(entry, options)
		const hypothesis = response.payloads
			.map((payload) => payload.text.trim())
			.filter(Boolean)
			.join("\n")
			.trim()

		results.push({
			question_id: entry.question_id,
			question_type: entry.question_type,
			question: entry.question,
			answer: entry.answer,
			question_date: entry.question_date,
			hypothesis,
			imported_memories,
			prompt_tokens: response.meta.agentMeta?.usage?.input,
			completion_tokens: response.meta.agentMeta?.usage?.output,
		})
	}

	const predictionsPath = join(options.outputDir, "predictions.jsonl")
	const summaryPath = join(options.outputDir, "summary.json")
	const selectionPath = join(options.outputDir, "selection.json")
	const configPath = join(options.outputDir, "resolved-options.json")

	await writeJsonl(
		predictionsPath,
		results.map((result) => ({
			question_id: result.question_id,
			hypothesis: result.hypothesis,
			question_type: result.question_type,
			question: result.question,
			answer: result.answer,
			question_date: result.question_date,
			imported_memories: result.imported_memories,
			prompt_tokens: result.prompt_tokens,
			completion_tokens: result.completion_tokens,
		})),
	)

	await writeJsonFile(selectionPath, entries)
	await writeJsonFile(configPath, {
		...options,
		embedding: {
			...options.embedding,
			apiKey: options.embedding.apiKey ? "<redacted>" : undefined,
		},
	})

	const summary = summarizeResults(results, options)
	let officialEval:
		| {
				resultPath: string
				stdout: string
		  }
		| undefined

	if (options.runOfficialEval) {
		officialEval = await runOfficialEval(options, predictionsPath)
		await writeFile(
			join(options.outputDir, "official-eval.stdout.log"),
			officialEval.stdout,
			"utf8",
		)
	}

	await writeJsonFile(summaryPath, {
		...summary,
		officialEval,
	})

	if (!options.keepProfile) {
		await rm(profileRoot, { recursive: true, force: true })
	}

	console.log(
		JSON.stringify(
			{
				predictionsPath,
				summaryPath,
				profile: options.profile,
				profileKept: options.keepProfile,
				total: summary.total,
				byType: summary.byType,
				officialEval,
			},
			null,
			2,
		),
	)
}

function parseCli(argv: string[]): CliOptions {
	const parsed: CliOptions = {
		profile: `longmemeval-${randomUUID().slice(0, 8)}`,
		preset: "smoke",
		keepProfile: false,
		runOfficialEval: false,
		help: false,
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case "--help":
			case "-h":
				parsed.help = true
				break
			case "--data-file":
				parsed.dataFile = expectValue(arg, argv[++i])
				break
			case "--preset":
				parsed.preset = parsePreset(expectValue(arg, argv[++i]))
				break
			case "--limit":
				parsed.limit = Number.parseInt(expectValue(arg, argv[++i]), 10)
				break
			case "--keep-profile":
				parsed.keepProfile = true
				break
			case "--official-repo":
				parsed.officialRepo = expectValue(arg, argv[++i])
				break
			case "--run-official-eval":
				parsed.runOfficialEval = true
				break
			default:
				throw new Error(`Unknown argument: ${arg}`)
		}
	}

	return parsed
}

function printHelp(): void {
	console.log(`Usage: bun run test:integration:longmemeval [options]

Options:
  --data-file PATH               Optional LongMemEval JSON file. Defaults to the bundled oracle fixture.
  --preset PRESET                smoke|full (default: smoke)
  --limit N                      Max number of questions after preset filtering.
  --keep-profile                 Keep the generated ~/.openclaw-<profile> state after the run.
  --run-official-eval            Run LongMemEval's official Python evaluator after generation.
  --official-repo PATH           Local checkout of the LongMemEval repo.

Environment:
  The runner auto-loads .env.local and .env from the repo root before reading env defaults.
  The only supported env defaults are:
  ${RUNNER_ENV.sourceStateDir}
  ${RUNNER_ENV.officialRepo}

Notes:
  No repo-local correctness heuristic is computed. Use --run-official-eval for LongMemEval scoring.

Examples:
  bun run test:integration:longmemeval
  bun run test:integration:longmemeval --preset full
  bun run test:integration:longmemeval --run-official-eval --official-repo /tmp/LongMemEval`)
}

function expectValue(flag: string, value: string | undefined): string {
	if (!value) {
		throw new Error(`Missing value for ${flag}`)
	}
	return value
}

function parsePreset(value: string): EvalPreset {
	if ((SUPPORTED_PRESETS as readonly string[]).includes(value)) {
		return value as EvalPreset
	}

	throw new Error(
		`Unsupported preset "${value}". Use one of: ${SUPPORTED_PRESETS.join(", ")}`,
	)
}

function loadRunnerEnvFiles(): void {
	for (const fileName of DOTENV_FILE_NAMES) {
		const envFilePath = join(REPO_ROOT, fileName)
		if (!existsSync(envFilePath)) continue
		process.loadEnvFile(envFilePath)
	}
}

async function readPackageVersion(): Promise<string> {
	const raw = await readFile(PACKAGE_JSON_PATH, "utf8")
	const parsed = JSON.parse(raw) as { version?: unknown }
	if (typeof parsed.version === "string" && parsed.version.length > 0) {
		return parsed.version
	}

	throw new Error(`Missing package version in ${PACKAGE_JSON_PATH}`)
}

async function resolveOptions(cli: CliOptions): Promise<ResolvedOptions> {
	const sourceStateDir = resolveTilde(
		readEnvString(RUNNER_ENV.sourceStateDir) ?? FALLBACK_SOURCE_STATE_DIR,
	)
	const sourceConfig = await maybeReadJson<SourceConfig>(
		join(sourceStateDir, "openclaw.json"),
	)
	const sourcePluginConfig =
		sourceConfig?.plugins?.entries?.["openclaw-memory-supermemory"]?.config ??
		{}
	const dataFile = resolveDataFile(cli.dataFile)
	const outputDir = join(
		RUN_ROOT,
		new Date().toISOString().replace(/[:.]/g, "-"),
	)
	const model =
		sourceConfig?.agents?.defaults?.model?.primary ?? FALLBACK_QA_MODEL
	const embedding = await resolveEmbeddingConfig(
		sourcePluginConfig,
		sourceStateDir,
	)

	return {
		...cli,
		officialRepo: cli.officialRepo ?? readEnvString(RUNNER_ENV.officialRepo),
		sourceStateDir,
		dataFile,
		outputDir,
		model,
		embedding,
	}
}

async function resolveEmbeddingConfig(
	sourcePluginConfig: Record<string, unknown>,
	sourceStateDir: string,
): Promise<EmbeddingConfig> {
	const raw = (sourcePluginConfig.embedding ?? {}) as Record<string, unknown>
	const enabled = raw.enabled !== false
	const provider =
		(typeof raw.provider === "string" ? raw.provider : undefined) ??
		((await readOpenAiApiKey(sourceStateDir)) ? "openai" : "ollama")
	const model =
		(typeof raw.model === "string" ? raw.model : undefined) ??
		(provider === "ollama"
			? FALLBACK_OLLAMA_EMBEDDING_MODEL
			: FALLBACK_OPENAI_EMBEDDING_MODEL)
	const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : undefined

	if (provider === "ollama") {
		return {
			enabled,
			provider,
			model,
			baseUrl,
		}
	}

	if (!enabled) {
		return {
			enabled,
			provider,
			model,
			baseUrl,
		}
	}

	const apiKey =
		(typeof raw.apiKey === "string" ? raw.apiKey : undefined) ??
		process.env.OPENAI_API_KEY ??
		(await readOpenAiApiKey(sourceStateDir))

	if (!apiKey) {
		throw new Error(
			`Embedding provider "${provider}" requires an API key. Configure it in ${sourceStateDir} or set OPENAI_API_KEY.`,
		)
	}

	return {
		enabled,
		provider,
		model,
		apiKey,
		baseUrl,
	}
}

function readEnvString(name: string): string | undefined {
	const value = process.env[name]
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

async function loadEntries(
	options: ResolvedOptions,
): Promise<LongMemEvalEntry[]> {
	const data = await readJsonFile<LongMemEvalEntry[]>(options.dataFile)
	let filtered =
		options.preset === "full" ? [...data] : buildSmokeSelection(data)
	if (typeof options.limit === "number") {
		filtered = filtered.slice(0, options.limit)
	}

	return filtered
}

function buildSmokeSelection(entries: LongMemEvalEntry[]): LongMemEvalEntry[] {
	const picked: LongMemEvalEntry[] = []
	const seenQuestionIds = new Set<string>()
	const seenQuestionTypes = new Set<string>()

	for (const entry of entries) {
		if (entry.question_id.endsWith("_abs")) continue
		if (seenQuestionTypes.has(entry.question_type)) continue

		picked.push(entry)
		seenQuestionTypes.add(entry.question_type)
		seenQuestionIds.add(entry.question_id)
	}

	const abstention = entries.find((entry) => entry.question_id.endsWith("_abs"))
	if (abstention && !seenQuestionIds.has(abstention.question_id)) {
		picked.push(abstention)
	}

	return picked
}

function resolveDataFile(dataFile?: string): string {
	if (dataFile) return resolve(dataFile)

	if (!existsSync(BUNDLED_DATA_FILE)) {
		throw new Error(
			`Bundled LongMemEval fixture not found at ${BUNDLED_DATA_FILE}. Restore the repo test artifacts or pass --data-file.`,
		)
	}

	return BUNDLED_DATA_FILE
}

function resolveProfileRoot(profile: string): string {
	return join(homedir(), `.openclaw-${profile}`)
}

async function prepareEvalProfile(
	options: ResolvedOptions,
	profileRoot: string,
): Promise<void> {
	const packageVersion = await readPackageVersion()
	await rm(profileRoot, { recursive: true, force: true })

	const workspaceDir = join(profileRoot, "workspace")
	const memoryDir = join(profileRoot, "memory")
	const agentDir = join(profileRoot, "agents", "main", "agent")

	await mkdir(workspaceDir, { recursive: true })
	await mkdir(memoryDir, { recursive: true })
	await mkdir(agentDir, { recursive: true })

	await maybeCopy(
		join(
			options.sourceStateDir,
			"agents",
			"main",
			"agent",
			"auth-profiles.json",
		),
		join(agentDir, "auth-profiles.json"),
	)
	await maybeCopy(
		join(options.sourceStateDir, "agents", "main", "agent", "models.json"),
		join(agentDir, "models.json"),
	)

	const config = {
		gateway: {
			mode: "local",
			bind: "loopback",
			port: 19789,
		},
		plugins: {
			allow: ["openclaw-memory-supermemory"],
			load: {
				paths: [REPO_ROOT],
			},
			slots: {
				memory: "openclaw-memory-supermemory",
			},
			entries: {
				"openclaw-memory-supermemory": {
					enabled: true,
					config: {
						dbPath: join(memoryDir, "supermemory.db"),
						autoCapture: false,
						autoRecall: true,
						profileFrequency: 1000,
						maxRecallResults: FALLBACK_MAX_RECALL_RESULTS,
						embedding: {
							provider: options.embedding.provider,
							model: options.embedding.model,
							apiKey: options.embedding.apiKey
								? `\${${EMBEDDING_API_KEY_ENV}}`
								: undefined,
							baseUrl: options.embedding.baseUrl,
						},
					},
				},
				"memory-core": {
					enabled: false,
				},
				"memory-lancedb": {
					enabled: false,
				},
			},
			installs: {
				"openclaw-memory-supermemory": {
					source: "path",
					sourcePath: REPO_ROOT,
					installPath: REPO_ROOT,
					version: packageVersion,
				},
			},
		},
		agents: {
			defaults: {
				model: {
					primary: options.model,
				},
				models: {
					[options.model]: {},
				},
				workspace: workspaceDir,
				compaction: {
					mode: "safeguard",
				},
			},
			list: [
				{
					id: "main",
					model: options.model,
				},
			],
		},
	}

	await writeJsonFile(join(profileRoot, "openclaw.json"), config)
}

async function importBenchmarkEntry(
	options: ResolvedOptions,
	entry: LongMemEvalEntry,
	profileRoot: string,
): Promise<number> {
	const cfg = parseSupermemoryConfig({
		dbPath: join(profileRoot, "memory", "supermemory.db"),
		autoCapture: false,
		autoRecall: true,
		profileFrequency: 1000,
		maxRecallResults: FALLBACK_MAX_RECALL_RESULTS,
		embedding: options.embedding,
	})
	const vectorDims = vectorDimsForModel(
		cfg.embedding.model,
		cfg.embedding.dimensions,
	)
	const db = new MemoryDB(cfg, vectorDims)
	const embeddings = createEmbeddingProvider(cfg.embedding, vectorDims, db)

	try {
		db.wipeAll()

		const memories = buildImportMemories(entry)
		for (const memory of memories) {
			await processNewMemory(memory.text, db, embeddings, {
				createdAt: memory.timestampMs,
				updatedAt: memory.timestampMs,
				referenceTimeMs: memory.timestampMs,
			})
		}

		buildUserProfile(db, cfg)
		return memories.length
	} finally {
		db.close()
	}
}

function buildImportMemories(entry: LongMemEvalEntry): ImportMemory[] {
	const memories: ImportMemory[] = []

	for (
		let sessionIndex = 0;
		sessionIndex < entry.haystack_sessions.length;
		sessionIndex++
	) {
		const sessionDate = entry.haystack_dates[sessionIndex]
		const sessionTurns = entry.haystack_sessions[sessionIndex] ?? []
		const baseTimestamp = parseLongMemEvalDate(sessionDate)
		const cleanedTurns = sessionTurns
			.map((turn) => ({
				role: turn.role,
				content: turn.content.trim(),
			}))
			.filter((turn) => turn.content.length > 0)

		if (cleanedTurns.length === 0) continue

		const rounds = toRounds(cleanedTurns)
		for (let roundIndex = 0; roundIndex < rounds.length; roundIndex++) {
			memories.push({
				text: formatSessionBlock(
					"Round Content",
					sessionDate,
					rounds[roundIndex],
				),
				timestampMs: baseTimestamp + roundIndex * 1000,
			})
		}
	}

	return memories
}

function toRounds(
	turns: Array<{ role: string; content: string }>,
): Array<Array<{ role: string; content: string }>> {
	const rounds: Array<Array<{ role: string; content: string }>> = []

	for (let i = 0; i < turns.length; i++) {
		const current = turns[i]
		const next = turns[i + 1]

		if (current.role === "user" && next && next.role === "assistant") {
			rounds.push([current, next])
			i++
			continue
		}

		rounds.push([current])
	}

	return rounds
}

function formatSessionBlock(
	sectionTitle: string,
	sessionDate: string,
	turns: Array<{ role: string; content: string }>,
): string {
	return [
		`Session Date: ${sessionDate}`,
		`${sectionTitle}:`,
		...turns.map((turn) => `${turn.role}: ${turn.content}`),
	].join("\n")
}

async function askOpenClaw(
	entry: LongMemEvalEntry,
	options: ResolvedOptions,
): Promise<OpenClawAgentResponse> {
	const args = [
		"--profile",
		options.profile,
		"--log-level",
		"error",
		"agent",
		"--local",
	]
	args.push(
		"--json",
		"--session-id",
		`longmemeval-${entry.question_id}`,
		"--thinking",
		"off",
		"--message",
		buildQuestionPrompt(entry),
	)

	const { stdout, stderr } = await runCommand("openclaw", args, {
		cwd: REPO_ROOT,
	})
	return parseOpenClawAgentResponse(stdout, stderr)
}

function buildQuestionPrompt(entry: LongMemEvalEntry): string {
	const abstentionInstruction = entry.question_id.endsWith("_abs")
		? 'If the answer is unavailable from memory, say "I don\'t know."'
		: "Answer using only the remembered chat history."

	return [
		`Current Date: ${entry.question_date}`,
		abstentionInstruction,
		`Question: ${entry.question}`,
	].join("\n\n")
}

function summarizeResults(
	results: RunResult[],
	options: ResolvedOptions,
): {
	preset: EvalPreset
	total: number
	byType: Record<string, { total: number }>
} {
	const byType = new Map<string, { total: number }>()

	for (const result of results) {
		const bucket = byType.get(result.question_type) ?? { total: 0 }
		bucket.total += 1
		byType.set(result.question_type, bucket)
	}

	return {
		preset: options.preset,
		total: results.length,
		byType: Object.fromEntries(
			[...byType.entries()].map(([questionType, stats]) => [
				questionType,
				{ total: stats.total },
			]),
		),
	}
}

async function runOfficialEval(
	options: ResolvedOptions,
	predictionsPath: string,
): Promise<{ resultPath: string; stdout: string }> {
	const officialRepo = options.officialRepo
		? resolve(options.officialRepo)
		: resolve(FALLBACK_OFFICIAL_REPO)
	const evaluatorPath = join(
		officialRepo,
		"src",
		"evaluation",
		"evaluate_qa.py",
	)
	if (!existsSync(evaluatorPath)) {
		throw new Error(
			`Official evaluator not found at ${evaluatorPath}. Pass --official-repo with a local LongMemEval checkout.`,
		)
	}

	const { stdout, stderr } = await runCommand(
		"python3",
		[
			evaluatorPath,
			FALLBACK_OFFICIAL_METRIC_MODEL,
			predictionsPath,
			options.dataFile,
		],
		{
			cwd: officialRepo,
		},
	)

	return {
		resultPath: `${predictionsPath}.eval-results-${FALLBACK_OFFICIAL_METRIC_MODEL}`,
		stdout: [stdout, stderr].filter(Boolean).join("\n"),
	}
}

async function readOpenAiApiKey(
	sourceStateDir: string,
): Promise<string | undefined> {
	const authPath = join(
		sourceStateDir,
		"agents",
		"main",
		"agent",
		"auth-profiles.json",
	)
	if (!existsSync(authPath)) return undefined

	const auth = await readJsonFile<AuthProfiles>(authPath)
	const profiles = auth.profiles ?? {}
	for (const profile of Object.values(profiles)) {
		if (
			profile.provider === "openai" &&
			profile.type === "api_key" &&
			profile.key
		) {
			return profile.key
		}
	}
	return undefined
}

function parseLongMemEvalDate(value: string): number {
	const match = value.match(
		/^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]{3}\) (\d{2}):(\d{2})$/,
	)
	if (!match) {
		const fallback = Date.parse(value)
		if (Number.isNaN(fallback)) {
			throw new Error(`Unrecognized LongMemEval date: ${value}`)
		}
		return fallback
	}

	const [, year, month, day, hour, minute] = match
	return new Date(
		Number.parseInt(year, 10),
		Number.parseInt(month, 10) - 1,
		Number.parseInt(day, 10),
		Number.parseInt(hour, 10),
		Number.parseInt(minute, 10),
	).getTime()
}

async function maybeReadJson<T>(path: string): Promise<T | undefined> {
	if (!existsSync(path)) return undefined
	return readJsonFile<T>(path)
}

async function readJsonFile<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	const body = rows.map((row) => JSON.stringify(row)).join("\n")
	await writeFile(path, `${body}\n`, "utf8")
}

async function maybeCopy(source: string, destination: string): Promise<void> {
	if (!existsSync(source)) return
	await mkdir(dirname(destination), { recursive: true })
	await copyFile(source, destination)
}

function resolveTilde(input: string): string {
	if (input === "~") return homedir()
	if (input.startsWith("~/")) return join(homedir(), input.slice(2))
	return resolve(input)
}

function parseOpenClawAgentResponse(
	stdout: string,
	stderr: string,
): OpenClawAgentResponse {
	const candidates = [
		stdout.trim(),
		stderr.trim(),
		[stdout, stderr].filter(Boolean).join("\n").trim(),
	].filter(Boolean)

	for (const candidate of candidates) {
		const parsed = tryParseJson<OpenClawAgentResponse>(candidate)
		if (parsed) return parsed

		const extracted = extractJsonObject(candidate)
		if (extracted) {
			const extractedParsed = tryParseJson<OpenClawAgentResponse>(extracted)
			if (extractedParsed) return extractedParsed
		}
	}

	throw new Error(
		[
			"Could not parse JSON from openclaw agent output.",
			stdout.trim() ? `stdout:\n${stdout.trim()}` : undefined,
			stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
		]
			.filter(Boolean)
			.join("\n\n"),
	)
}

function tryParseJson<T>(value: string): T | undefined {
	try {
		return JSON.parse(value) as T
	} catch {
		return undefined
	}
}

function extractJsonObject(value: string): string | undefined {
	const start = value.indexOf("{")
	const end = value.lastIndexOf("}")
	if (start === -1 || end === -1 || end <= start) return undefined
	return value.slice(start, end + 1)
}

type RunCommandOptions = {
	cwd?: string
}

async function runCommand(
	command: string,
	args: string[],
	options?: RunCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd: options?.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		})

		let stdout = ""
		let stderr = ""

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString()
		})
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString()
		})

		child.on("error", (error) => {
			rejectPromise(error)
		})

		child.on("close", (code) => {
			if (code === 0) {
				resolvePromise({
					stdout: stdout.trim(),
					stderr: stderr.trim(),
				})
				return
			}

			rejectPromise(
				new Error(
					[
						`${command} ${args.join(" ")} failed with exit code ${code}`,
						stdout.trim(),
						stderr.trim(),
					]
						.filter(Boolean)
						.join("\n"),
				),
			)
		})
	})
}

type OpenClawAgentResponse = {
	payloads: Array<{
		text: string
		mediaUrl: string | null
	}>
	meta: {
		agentMeta?: {
			usage?: {
				input?: number
				output?: number
			}
		}
	}
}

await main()
