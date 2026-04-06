import type { MemoryType, RelationType } from "./config.ts"
import {
	runSubagentJsonTask,
	type SemanticLogger,
	type SemanticSubagentRuntime,
} from "./semantic-runtime.ts"

export type ExtractedEntityMention = {
	mention: string
	kind: string | null
}

export type ExtractedMemoryCandidate = {
	text: string
	memoryType: MemoryType
	entities: ExtractedEntityMention[]
	expiresAtIso: string | null
}

export type MemoryRelationshipDecision = {
	targetId: string
	relationType: RelationType | "none"
}

export type UpdateResolverCandidate = {
	id: string
	text: string
	memoryType: MemoryType
	entityIds: string[]
	createdAt: number
}

export type EntityMergeCandidate = {
	leftEntityId: string
	leftCanonicalName: string
	leftAliases: string[]
	rightEntityId: string
	rightCanonicalName: string
	rightAliases: string[]
}

export type EntityMergeDecision = {
	leftEntityId: string
	rightEntityId: string
	decision: "same" | "different"
}

const EXTRACTOR_TURN_MIN_CHARS = 15
const EXTRACTOR_MAX_ITEMS = 10
const EXTRACTOR_ITEM_MIN_CHARS = 10
const EXTRACTOR_ITEM_MAX_CHARS = 500
const RESOLVER_MAX_CANDIDATES = 12
const MERGE_RESOLVER_MAX_PAIRS = 24

export type SemanticRuntimeLike = SemanticSubagentRuntime
export type SemanticLogLike = SemanticLogger

export async function extractMemoryCandidates(
	turnText: string,
	subagent: SemanticSubagentRuntime,
	log: SemanticLogger,
	options?: { referenceTimeMs?: number; maxItems?: number },
): Promise<ExtractedMemoryCandidate[]> {
	if (!turnText || turnText.trim().length < EXTRACTOR_TURN_MIN_CHARS) return []

	const referenceTimeIso = new Date(
		options?.referenceTimeMs ?? Date.now(),
	).toISOString()
	const maxItems = options?.maxItems ?? EXTRACTOR_MAX_ITEMS
	const systemPrompt = `You are a multilingual memory extraction engine. Read the input and return a JSON array only.

Each array item must have exactly these keys:
- "text": string
- "memoryType": one of "fact", "preference", "episode"
- "entities": array of objects with exactly:
  - "mention": string
  - "kind": string or null
- "expiresAtIso": string or null

Rules:
- The input may be in any language. Extract all memories and entity mentions in the exact original language of the input. Do not translate them to English.
- "memoryType" must still use the English enum values above.
- Keep each memory atomic: one discrete memory per item.
- Preserve the original surface form for each entity mention.
- "kind" is optional free-form metadata. Use null if unsure.
- Only set "expiresAtIso" when the memory is an "episode".
- Resolve relative time expressions against this reference timestamp: ${referenceTimeIso}
- "expiresAtIso" must be a valid ISO-8601 timestamp or null.
- Skip greetings, filler, pure questions, code, stack traces, and generic assistant advice.
- Maximum ${maxItems} items.
- If nothing is worth storing, return [].

Return only valid JSON. No markdown, no prose, no comments.`

	try {
		const raw = await runSubagentJsonTask({
			runtime: subagent,
			taskPrefix: "__supermemory-extract",
			message: turnText,
			systemPrompt,
		})

		if (!raw?.trim()) return []
		const parsed = parseExtractionJson(raw, maxItems)
		if (!parsed) {
			log.warn("extractor returned malformed JSON; skipping turn")
			return []
		}

		if (parsed.length > 0) {
			log.info(`extracted ${parsed.length} semantic memories from text`)
			log.debug?.(
				`extraction items: ${parsed
					.map(
						(c) =>
							`[${c.memoryType}] "${c.text.slice(0, 60)}" (${c.entities.length} entities)`,
					)
					.join(" | ")}`,
			)
		}

		return parsed
	} catch (err) {
		log.warn(`extraction error: ${String(err)}`)
		return []
	}
}

export async function resolveMemoryRelationships(
	newMemory: {
		text: string
		memoryType: MemoryType
		entityIds: string[]
	},
	candidates: UpdateResolverCandidate[],
	subagent: SemanticSubagentRuntime,
	log: SemanticLogger,
): Promise<MemoryRelationshipDecision[]> {
	if (candidates.length === 0) return []

	const trimmedCandidates = candidates.slice(0, RESOLVER_MAX_CANDIDATES)
	const payload = JSON.stringify(
		{
			newMemory,
			candidates: trimmedCandidates,
		},
		null,
		2,
	)

	const systemPrompt = `You are a multilingual semantic memory resolver. Compare one new memory against candidate existing memories and decide, for each candidate, whether it is:
- "updates": the new memory replaces, corrects, or supersedes the candidate
- "related": the memories are meaningfully about the same entity/topic but neither supersedes the other
- "none": no useful relationship

Rules:
- Input text may be in any language.
- Respect the provided "memoryType"; do not reinterpret it.
- Be conservative with "updates". Use it only when the new memory clearly replaces or corrects the old one.
- If in doubt between "related" and "none", prefer "related" only when the semantic connection is genuinely strong.
- Return a JSON array only.
- Each item must have exactly:
  - "targetId": string
  - "relationType": one of "updates", "related", "none"
- Return at most one "updates" decision across the whole array.
- Keep the returned order meaningful, with the strongest decisions first.`

	try {
		const raw = await runSubagentJsonTask({
			runtime: subagent,
			taskPrefix: "__supermemory-relate",
			message: payload,
			systemPrompt,
		})

		if (!raw?.trim()) return []
		const parsed = parseRelationshipJson(raw)
		if (!parsed) {
			log.warn("relationship resolver returned malformed JSON")
			return []
		}

		let seenUpdate = false
		const filtered: MemoryRelationshipDecision[] = []
		for (const decision of parsed) {
			if (
				!trimmedCandidates.some(
					(candidate) => candidate.id === decision.targetId,
				)
			)
				continue
			if (decision.relationType === "updates") {
				if (seenUpdate) continue
				seenUpdate = true
			}
			filtered.push(decision)
		}

		if (filtered.length > 0) {
			const updates = filtered.filter(
				(d) => d.relationType === "updates",
			).length
			const related = filtered.filter(
				(d) => d.relationType === "related",
			).length
			log.debug?.(
				`relationship resolver: updates=${updates}, related=${related}, none=${filtered.filter((d) => d.relationType === "none").length}`,
			)
		}

		return filtered
	} catch (err) {
		log.warn(`relationship resolver error: ${String(err)}`)
		return []
	}
}

export async function resolveEntityEquivalences(
	pairs: EntityMergeCandidate[],
	subagent: SemanticSubagentRuntime,
	log: SemanticLogger,
): Promise<EntityMergeDecision[]> {
	if (pairs.length === 0) return []

	const trimmedPairs = pairs.slice(0, MERGE_RESOLVER_MAX_PAIRS)
	const payload = JSON.stringify({ pairs: trimmedPairs }, null, 2)

	const systemPrompt = `You are a multilingual entity-equivalence resolver. Decide whether each pair of canonical entities refers to the same real-world entity.

Rules:
- Input text may be in any language.
- Treat spelling variants, transliteration variants, abbreviations, and accent differences as potentially the same entity.
- Do not merge entities merely because they are semantically related or share a topic.
- Return a JSON array only.
- Each item must have exactly:
  - "leftEntityId": string
  - "rightEntityId": string
  - "decision": "same" or "different"`

	try {
		const raw = await runSubagentJsonTask({
			runtime: subagent,
			taskPrefix: "__supermemory-entity-merge",
			message: payload,
			systemPrompt,
		})

		if (!raw?.trim()) return []
		const parsed = parseEntityMergeJson(raw)
		if (!parsed) {
			log.warn("entity merge resolver returned malformed JSON")
			return []
		}

		return parsed.filter((decision) =>
			trimmedPairs.some(
				(pair) =>
					pair.leftEntityId === decision.leftEntityId &&
					pair.rightEntityId === decision.rightEntityId,
			),
		)
	} catch (err) {
		log.warn(`entity merge resolver error: ${String(err)}`)
		return []
	}
}

function parseExtractionJson(
	raw: string,
	maxItems?: number,
): ExtractedMemoryCandidate[] | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw.trim())
	} catch {
		return null
	}

	if (!Array.isArray(parsed)) return null

	const limit = maxItems ?? EXTRACTOR_MAX_ITEMS
	const results: ExtractedMemoryCandidate[] = []
	for (const item of parsed.slice(0, limit)) {
		const candidate = coerceMemoryCandidate(item)
		if (candidate) {
			results.push(candidate)
		}
	}

	return results
}

function coerceMemoryCandidate(
	value: unknown,
): ExtractedMemoryCandidate | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null
	const row = value as Record<string, unknown>

	if (
		typeof row.text !== "string" ||
		row.text.trim().length < EXTRACTOR_ITEM_MIN_CHARS ||
		row.text.trim().length > EXTRACTOR_ITEM_MAX_CHARS
	) {
		return null
	}

	const memoryType = normalizeMemoryType(row.memoryType)
	if (!memoryType) return null

	const entities = Array.isArray(row.entities)
		? row.entities
				.map(coerceEntityMention)
				.filter((entity): entity is ExtractedEntityMention => entity !== null)
		: []

	const expiresAtIso =
		memoryType === "episode" ? normalizeIsoTimestamp(row.expiresAtIso) : null

	return {
		text: row.text.trim(),
		memoryType,
		entities,
		expiresAtIso,
	}
}

function coerceEntityMention(value: unknown): ExtractedEntityMention | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null
	const row = value as Record<string, unknown>
	if (typeof row.mention !== "string") return null
	const mention = row.mention.trim()
	if (mention.length === 0) return null

	const kind =
		typeof row.kind === "string" && row.kind.trim().length > 0
			? row.kind.trim()
			: null

	return { mention, kind }
}

function parseRelationshipJson(
	raw: string,
): MemoryRelationshipDecision[] | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw.trim())
	} catch {
		return null
	}

	if (!Array.isArray(parsed)) return null

	const results: MemoryRelationshipDecision[] = []
	for (const item of parsed) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue
		const row = item as Record<string, unknown>
		if (typeof row.targetId !== "string") continue
		if (!isDecisionRelationType(row.relationType)) continue
		results.push({
			targetId: row.targetId,
			relationType: row.relationType,
		})
	}
	return results
}

function parseEntityMergeJson(raw: string): EntityMergeDecision[] | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw.trim())
	} catch {
		return null
	}

	if (!Array.isArray(parsed)) return null

	const results: EntityMergeDecision[] = []
	for (const item of parsed) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue
		const row = item as Record<string, unknown>
		if (
			typeof row.leftEntityId !== "string" ||
			typeof row.rightEntityId !== "string"
		)
			continue
		if (row.decision !== "same" && row.decision !== "different") continue
		results.push({
			leftEntityId: row.leftEntityId,
			rightEntityId: row.rightEntityId,
			decision: row.decision,
		})
	}
	return results
}

function normalizeMemoryType(value: unknown): MemoryType | null {
	if (value === "fact" || value === "preference" || value === "episode") {
		return value
	}
	return null
}

function isDecisionRelationType(
	value: unknown,
): value is RelationType | "none" {
	return value === "updates" || value === "related" || value === "none"
}

function normalizeIsoTimestamp(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) return null
	const parsed = Date.parse(value)
	if (Number.isNaN(parsed)) return null
	return new Date(parsed).toISOString()
}
