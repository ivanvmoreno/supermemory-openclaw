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

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_SESSION_MESSAGE_LIMIT = 8

export async function runSubagentJsonTask(params: {
	runtime: SemanticSubagentRuntime
	taskPrefix: string
	message: string
	systemPrompt: string
	timeoutMs?: number
	sessionMessageLimit?: number
}): Promise<string | null> {
	const sessionKey = `${params.taskPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
	const idempotencyKey = `${params.taskPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

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
		} catch {}
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
