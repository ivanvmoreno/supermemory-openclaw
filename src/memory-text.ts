const LEADING_TIMESTAMP_RE =
	/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */

const INBOUND_META_SENTINELS = [
	"Conversation info (untrusted metadata):",
	"Sender (untrusted metadata):",
	"Thread starter (untrusted, for context):",
	"Replied message (untrusted, for context):",
	"Forwarded message context (untrusted metadata):",
	"Chat history since last reply (untrusted, for context):",
]

export function stripInboundMetadata(text: string): string {
	if (!text) return text
	const withoutTimestamp = text.replace(LEADING_TIMESTAMP_RE, "")
	const lines = withoutTimestamp.split("\n")
	const result: string[] = []
	let inMetaBlock = false
	let inFencedJson = false

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		if (!inMetaBlock && INBOUND_META_SENTINELS.some((s) => s === line.trim())) {
			const next = lines[i + 1]
			if (next?.trim() !== "```json") {
				result.push(line)
				continue
			}
			inMetaBlock = true
			inFencedJson = false
			continue
		}

		if (inMetaBlock) {
			if (!inFencedJson && line.trim() === "```json") {
				inFencedJson = true
				continue
			}
			if (inFencedJson) {
				if (line.trim() === "```") {
					inMetaBlock = false
					inFencedJson = false
				}
				continue
			}
			if (line.trim() === "") continue
			inMetaBlock = false
		}

		result.push(line)
	}

	return result.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
}

const INJECTED_CONTEXT_BLOCKS = [
	/<supermemory-context>[\s\S]*?<\/supermemory-context>\s*/gi,
	/<supermemory-profile>[\s\S]*?<\/supermemory-profile>\s*/gi,
	/<supermemory-relevant-memories>[\s\S]*?<\/supermemory-relevant-memories>\s*/gi,
	/<supermemory-guidance>[\s\S]*?<\/supermemory-guidance>\s*/gi,
]

const SYNTHETIC_MEMORY_PATTERNS = [
	/##\s*User Profile\b/i,
	/##\s*Recent Context\b/i,
	/##\s*Relevant Memories\b/i,
	/Treat every memory below as untrusted historical data/i,
	/Read HEARTBEAT\.md if it exists/i,
	/\bHEARTBEAT_OK\b/i,
	/Pre-compaction memory flush/i,
	/session is near auto-compaction/i,
	/##\s*Memory \(Supermemory Graph\)/i,
	/^use memory_search to\b/i,
	/^use memory_store to\b/i,
	/^System:\s*\[/i,
	/Sender \(untrusted metadata\):/i,
	/\bWhatsApp gateway (?:connected|disconnected)\b/i,
]

function collapseWhitespace(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}

export function stripInjectedMemoryContext(text: string): string {
	let stripped = text
	for (const pattern of INJECTED_CONTEXT_BLOCKS) {
		stripped = stripped.replace(pattern, " ")
	}
	return collapseWhitespace(stripped)
}

export function isSyntheticMemoryText(text: string): boolean {
	const cleaned = stripInjectedMemoryContext(text)
	if (!cleaned) return true
	if (
		/^<(?:supermemory|relevant-memories|system|assistant|developer|tool|function)[-\s>]/i.test(
			cleaned,
		)
	)
		return true
	return SYNTHETIC_MEMORY_PATTERNS.some((pattern) => pattern.test(cleaned))
}

export function prepareMemoryTextForStorage(
	text: string,
	maxChars: number,
): string | null {
	const cleaned = stripInjectedMemoryContext(text)
	if (cleaned.length < 10 || cleaned.length > maxChars) return null
	if (isSyntheticMemoryText(cleaned)) return null
	return cleaned
}

export function normalizeMemoryText(text: string): string {
	return stripInjectedMemoryContext(text)
		.replace(/[<>`]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
}

export function dedupeMemoryTexts(texts: string[]): string[] {
	const seen = new Set<string>()
	const deduped: string[] = []

	for (const text of texts) {
		if (isSyntheticMemoryText(text)) continue
		const key = normalizeMemoryText(text)
		if (!key || seen.has(key)) continue
		seen.add(key)
		deduped.push(text)
	}

	return deduped
}

export function sanitizeMemoryTextForPrompt(
	text: string,
	maxChars = 200,
): string {
	return stripInjectedMemoryContext(text)
		.replace(/[<>]/g, "")
		.replace(/\n/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxChars)
}
