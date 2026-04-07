import { createHash, randomUUID } from "node:crypto"

export type SemanticSubagentRuntime = {
	runJsonTask?: (params: {
		sessionKey: string
		sessionId: string
		runId: string
		agentId?: string
		message: string
		systemPrompt: string
		timeoutMs: number
		idempotencyKey?: string
	}) => Promise<{
		text: string | null
		stopReason?: string
		error?: string
	}>
	run: (params: {
		sessionKey: string
		message: string
		extraSystemPrompt?: string
		deliver?: boolean
		idempotencyKey?: string
	}) => Promise<{ runId: string }>
	waitForRun: (params: {
		runId: string
		timeoutMs?: number
	}) => Promise<{ status: string; error?: string }>
	getSessionMessages: (params: {
		sessionKey: string
		limit?: number
	}) => Promise<{ messages: unknown[] }>
	deleteSession: (params: {
		sessionKey: string
		deleteTranscript?: boolean
	}) => Promise<void>
}

export type SemanticLogger = {
	info: (msg: string) => void
	warn: (msg: string) => void
	debug?: (msg: string) => void
}

export type SemanticTaskScope = {
	agentId?: string
	scopeKey?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_SESSION_MESSAGE_LIMIT = 8
const DEFAULT_AGENT_ID = "main"
const DEFAULT_TASK_SLUG = "task"
const DEFAULT_SCOPE_HASH = "global"
const SEMANTIC_SUBAGENT_SESSION_MARKER = ":subagent:supermemory:"

function normalizeAgentId(agentId?: string): string {
	const normalized = (agentId ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")

	return normalized || DEFAULT_AGENT_ID
}

function normalizeSemanticTaskSlug(taskPrefix: string): string {
	const sanitized = taskPrefix
		.trim()
		.toLowerCase()
		.replace(/^_+/, "")
		.replace(/^supermemory-/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")

	return sanitized || DEFAULT_TASK_SLUG
}

function buildScopeHash(scopeKey?: string): string {
	const normalized = scopeKey?.trim()
	if (!normalized) return DEFAULT_SCOPE_HASH

	return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}

function buildSemanticSubagentSessionKey(params: {
	taskPrefix: string
	semanticScope?: SemanticTaskScope | null
}): string {
	const agentId = normalizeAgentId(params.semanticScope?.agentId)
	const taskSlug = normalizeSemanticTaskSlug(params.taskPrefix)
	const scopeHash = buildScopeHash(params.semanticScope?.scopeKey)

	return `agent:${agentId}:subagent:supermemory:${taskSlug}:${scopeHash}:run:${randomUUID()}`
}

export function isSemanticHelperSessionKey(
	sessionKey: string | null | undefined,
): boolean {
	return (
		typeof sessionKey === "string" &&
		sessionKey.includes(SEMANTIC_SUBAGENT_SESSION_MARKER)
	)
}

export async function runSubagentJsonTask(params: {
	runtime: SemanticSubagentRuntime
	taskPrefix: string
	message: string
	systemPrompt: string
	timeoutMs?: number
	semanticScope?: SemanticTaskScope | null
	log?: SemanticLogger
}): Promise<string | null> {
	const sessionKey = buildSemanticSubagentSessionKey({
		taskPrefix: params.taskPrefix,
		semanticScope: params.semanticScope,
	})
	const sessionId = `supermemory-${randomUUID()}`
	const runId = `supermemory-${normalizeSemanticTaskSlug(params.taskPrefix)}-${randomUUID()}`
	const idempotencyKey = `supermemory-${normalizeSemanticTaskSlug(params.taskPrefix)}-${randomUUID()}`

	if (params.runtime.runJsonTask) {
		const result = await params.runtime.runJsonTask({
			sessionKey,
			sessionId,
			runId,
			agentId: params.semanticScope?.agentId,
			message: params.message,
			systemPrompt: params.systemPrompt,
			timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			idempotencyKey,
		})

		if (result.error) {
			throw new Error(result.error)
		}

		if (!result.text?.trim()) {
			if (result.stopReason && result.stopReason !== "completed") {
				throw new Error(
					`semantic json task ended with stopReason=${result.stopReason}`,
				)
			}
			return null
		}

		return result.text
	}

	try {
		const { runId: subagentRunId } = await params.runtime.run({
			sessionKey,
			message: params.message,
			extraSystemPrompt: params.systemPrompt,
			deliver: false,
			idempotencyKey,
		})

		const result = await params.runtime.waitForRun({
			runId: subagentRunId,
			timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		})

		if (result.status !== "ok") {
			throw new Error(result.error ?? result.status)
		}

		const { messages } = await params.runtime.getSessionMessages({
			sessionKey,
			limit: DEFAULT_SESSION_MESSAGE_LIMIT,
		})

		return extractLatestAssistantText(messages)
	} finally {
		try {
			await params.runtime.deleteSession({
				sessionKey,
				deleteTranscript: true,
			})
		} catch (err) {
			params.log?.warn(
				`semantic session cleanup failed for ${sessionKey}: ${String(err)}`,
			)
		}
	}
}

function extractLatestAssistantText(messages: unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (!msg || typeof msg !== "object") continue
		if ((msg as Record<string, unknown>).role !== "assistant") continue

		const content = (msg as Record<string, unknown>).content
		if (typeof content === "string") {
			return content
		}

		if (!Array.isArray(content)) continue
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				(block as Record<string, unknown>).type === "text" &&
				typeof (block as Record<string, unknown>).text === "string"
			) {
				return (block as Record<string, unknown>).text as string
			}
		}
	}

	return null
}
