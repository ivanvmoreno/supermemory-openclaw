import type { SupermemoryConfig } from "./config.ts"
import type { MemoryDB, MemoryRow } from "./db.ts"
import type { EmbeddingProvider } from "./embeddings.ts"
import type { SemanticLogger } from "./semantic-runtime.ts"

export type SearchResult = {
	memory: MemoryRow
	score: number
	source: "vector" | "fts" | "graph"
	graphHop?: number
}

export type SearchMode = "hybrid" | "fts+graph" | "fts-only"

export type SearchOptions = {
	maxResults?: number
	minScore?: number
	includeSuperseded?: boolean
}

const GRAPH_NEW_MEMORY_SCORE = 0.5
const GRAPH_EXISTING_MEMORY_SCORE = 0.3
const MMR_SAME_SOURCE_PENALTY = 0.8

export function isVectorSearchActive(
	cfg: SupermemoryConfig,
	db: Pick<MemoryDB, "isVectorAvailable">,
): boolean {
	return cfg.embedding.enabled && db.isVectorAvailable && cfg.vectorWeight > 0
}

export function resolveSearchMode(
	cfg: SupermemoryConfig,
	db: Pick<MemoryDB, "isVectorAvailable">,
): SearchMode {
	if (isVectorSearchActive(cfg, db)) {
		return "hybrid"
	}
	return cfg.graphWeight > 0 ? "fts+graph" : "fts-only"
}

export async function hybridSearch(
	query: string,
	db: MemoryDB,
	embeddings: EmbeddingProvider,
	cfg: SupermemoryConfig,
	options?: SearchOptions,
	log?: SemanticLogger,
): Promise<SearchResult[]> {
	const maxResults = options?.maxResults ?? cfg.maxRecallResults
	const minScore = options?.minScore ?? cfg.minScore
	const fetchLimit = maxResults * 3

	const searchMode = resolveSearchMode(cfg, db)
	log?.debug?.(
		`hybridSearch start (mode=${searchMode}, maxResults=${maxResults}, minScore=${minScore}, query="${query.slice(0, 80)}")`,
	)

	const scoreMap = new Map<
		string,
		{ vectorScore: number; ftsScore: number; graphScore: number }
	>()

	function getEntry(id: string) {
		let entry = scoreMap.get(id)
		if (!entry) {
			entry = { vectorScore: 0, ftsScore: 0, graphScore: 0 }
			scoreMap.set(id, entry)
		}
		return entry
	}

	let vectorHits = 0
	if (isVectorSearchActive(cfg, db)) {
		try {
			const queryVector = await embeddings.embed(query)
			const vectorResults = db.vectorSearch(
				queryVector,
				fetchLimit,
				minScore * cfg.vectorMinScoreFactor,
			)
			for (const vr of vectorResults) {
				getEntry(vr.id).vectorScore = vr.score
			}
			vectorHits = vectorResults.length
			log?.debug?.(`vector search → ${vectorHits} hits`)
		} catch (err) {
			log?.debug?.(
				`vector search unavailable (${String(err).slice(0, 80)}), falling back to FTS`,
			)
		}
	} else {
		log?.debug?.("vector search skipped (disabled or unavailable)")
	}

	const ftsResults = db.ftsSearch(query, fetchLimit)
	for (const fr of ftsResults) {
		getEntry(fr.id).ftsScore = fr.score
	}
	log?.debug?.(`FTS search → ${ftsResults.length} hits`)

	let graphNew = 0
	if (cfg.graphWeight > 0) {
		const topIds = [...scoreMap.entries()]
			.sort((a, b) => {
				const aScore =
					a[1].vectorScore * cfg.vectorWeight + a[1].ftsScore * cfg.textWeight
				const bScore =
					b[1].vectorScore * cfg.vectorWeight + b[1].ftsScore * cfg.textWeight
				return bScore - aScore
			})
			.slice(0, cfg.graphSeedLimit)
			.map(([id]) => id)

		for (const seedId of topIds) {
			const related = db.getRelatedMemoryIds(seedId, cfg.graphHopDepth)
			for (const relatedId of related) {
				if (!scoreMap.has(relatedId)) {
					getEntry(relatedId).graphScore = GRAPH_NEW_MEMORY_SCORE
					graphNew++
				} else {
					getEntry(relatedId).graphScore = Math.max(
						getEntry(relatedId).graphScore,
						GRAPH_EXISTING_MEMORY_SCORE,
					)
				}
			}
		}
		log?.debug?.(
			`graph augmentation → ${graphNew} new candidates added (seeds=${topIds.length}, depth=${cfg.graphHopDepth})`,
		)
	}

	const { vectorWeight, textWeight, graphWeight } = cfg
	const totalWeight = vectorWeight + textWeight + graphWeight

	type ScoredItem = {
		id: string
		score: number
		primarySource: "vector" | "fts" | "graph"
	}
	const merged: ScoredItem[] = []
	for (const [id, scores] of scoreMap) {
		const combined =
			totalWeight > 0
				? (scores.vectorScore * vectorWeight +
						scores.ftsScore * textWeight +
						scores.graphScore * graphWeight) /
					totalWeight
				: Math.max(scores.vectorScore, scores.ftsScore, scores.graphScore)

		if (combined < minScore) continue

		const primarySource: "vector" | "fts" | "graph" =
			scores.vectorScore >= scores.ftsScore &&
			scores.vectorScore >= scores.graphScore
				? "vector"
				: scores.ftsScore >= scores.graphScore
					? "fts"
					: "graph"

		merged.push({ id, score: combined, primarySource })
	}

	merged.sort((a, b) => b.score - a.score)
	log?.debug?.(
		`merged score map → ${merged.length} candidates above minScore=${minScore}`,
	)

	const diversified = mmrRerank(
		merged,
		maxResults,
		cfg.mmrLambda,
		MMR_SAME_SOURCE_PENALTY,
	)
	log?.debug?.(`after MMR → ${diversified.length} results (λ=${cfg.mmrLambda})`)

	const results: SearchResult[] = []
	for (const item of diversified) {
		const memory = db.getMemory(item.id)
		if (!memory) continue
		if (memory.is_superseded && !options?.includeSuperseded) continue

		db.bumpAccessCount(item.id)
		results.push({
			memory,
			score: item.score,
			source: item.primarySource,
		})
	}

	return results.slice(0, maxResults)
}

function mmrRerank(
	items: Array<{
		id: string
		score: number
		primarySource: "vector" | "fts" | "graph"
	}>,
	limit: number,
	lambda: number,
	sameSourcePenalty: number,
): typeof items {
	if (items.length <= limit) return items

	const selected: typeof items = []
	const remaining = [...items]

	if (remaining.length > 0) {
		selected.push(remaining.shift()!)
	}

	while (selected.length < limit && remaining.length > 0) {
		let bestIdx = 0
		let bestScore = Number.NEGATIVE_INFINITY

		for (let i = 0; i < remaining.length; i++) {
			const relevance = remaining[i].score
			const lastSelected = selected[selected.length - 1]
			const diversity =
				lastSelected?.primarySource === remaining[i].primarySource
					? sameSourcePenalty
					: 1.0
			const mmrScore = lambda * relevance + (1 - lambda) * diversity

			if (mmrScore > bestScore) {
				bestScore = mmrScore
				bestIdx = i
			}
		}

		selected.push(remaining.splice(bestIdx, 1)[0])
	}

	return selected
}
