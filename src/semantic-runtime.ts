import { createHash, randomUUID } from "node:crypto"

export type SemanticSubagentRuntime = {
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
	parentSessionKey?: string
	scopeKey?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_SESSION_MESSAGE_LIMIT = 8
const DEFAULT_AGENT_ID = "main"
const DEFAULT_TASK_SLUG = "task"
const DEFAULT_SCOPE_HASH = "global"

function normalizeAgentId(agentId?: string): string {
	const normalized = (agentId ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")

	return normalized || DEFAULT_AGENT_ID
}

export function normalizeSemanticTaskSlug(taskPrefix: string): string {
	const sanitized = taskPrefix
		.trim()
		.toLowerCase()
		.replace(/^_+/, "")
		.replace(/^supermemory-/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")

	return sanitized || DEFAULT_TASK_SLUG
}

function buildScopeHash(scope: SemanticTaskScope): string {
	const parts = [scope.parentSessionKey?.trim(), scope.scopeKey?.trim()].filter(
		(value): value is string => Boolean(value),
	)
	if (parts.length === 0) return DEFAULT_SCOPE_HASH

	return createHash("sha256")
		.update(parts.join("\n"))
		.digest("hex")
		.slice(0, 16)
}

export function buildSemanticSubagentSessionKey(params: {
	taskPrefix: string
	agentId?: string
	parentSessionKey?: string
	scopeKey?: string
}): string {
	const agentId = normalizeAgentId(params.agentId)
	const taskSlug = normalizeSemanticTaskSlug(params.taskPrefix)
	const scopeHash = buildScopeHash({
		parentSessionKey: params.parentSessionKey,
		scopeKey: params.scopeKey,
	})

	return `agent:${agentId}:subagent:supermemory:${taskSlug}:${scopeHash}`
}

export async function runSubagentJsonTask(params: {
	runtime: SemanticSubagentRuntime
	taskPrefix: string
	message: string
	systemPrompt: string
	timeoutMs?: number
	sessionMessageLimit?: number
	agentId?: string
	parentSessionKey?: string
	scopeKey?: string
	log?: SemanticLogger
}): Promise<string | null> {
	const sessionKey = buildSemanticSubagentSessionKey({
		taskPrefix: params.taskPrefix,
		agentId: params.agentId,
		parentSessionKey: params.parentSessionKey,
		scopeKey: params.scopeKey,
	})
	const idempotencyKey = `supermemory-${normalizeSemanticTaskSlug(params.taskPrefix)}-${randomUUID()}`

	try {
		const { runId } = await params.runtime.run({
			sessionKey,
			message: params.message,
			extraSystemPrompt: params.systemPrompt,
			deliver: false,
			idempotencyKey,
		})

		const result = await params.runtime.waitForRun({
			runId,
			timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		})

		if (result.status !== "ok") {
			throw new Error(result.error ?? result.status)
		}

		const { messages } = await params.runtime.getSessionMessages({
			sessionKey,
			limit: params.sessionMessageLimit ?? DEFAULT_SESSION_MESSAGE_LIMIT,
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
