import type { SupermemoryConfig } from "./config.ts";
import type { MemoryDB, MemoryRow } from "./db.ts";
import type { EmbeddingProvider } from "./embeddings.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchResult = {
  memory: MemoryRow;
  score: number;
  source: "vector" | "fts" | "graph";
  graphHop?: number;
};

export type SearchOptions = {
  maxResults?: number;
  minScore?: number;
  containerTag?: string;
  includeSuperseded?: boolean;
};

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

export async function hybridSearch(
  query: string,
  db: MemoryDB,
  embeddings: EmbeddingProvider,
  cfg: SupermemoryConfig,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const maxResults = options?.maxResults ?? cfg.maxRecallResults;
  const minScore = options?.minScore ?? 0.1;
  const fetchLimit = maxResults * 3;

  const scoreMap = new Map<string, { vectorScore: number; ftsScore: number; graphScore: number }>();

  function getEntry(id: string) {
    let entry = scoreMap.get(id);
    if (!entry) {
      entry = { vectorScore: 0, ftsScore: 0, graphScore: 0 };
      scoreMap.set(id, entry);
    }
    return entry;
  }

  // 1. Vector search
  if (db.isVectorAvailable) {
    try {
      const queryVector = await embeddings.embed(query);
      const vectorResults = db.vectorSearch(queryVector, fetchLimit, minScore * 0.5);
      for (const vr of vectorResults) {
        getEntry(vr.id).vectorScore = vr.score;
      }
    } catch {
      // Vector search failed — continue with FTS only
    }
  }

  // 2. FTS search
  const ftsResults = db.ftsSearch(query, fetchLimit);
  for (const fr of ftsResults) {
    getEntry(fr.id).ftsScore = fr.score;
  }

  // 3. Graph augmentation — for top vector+fts results, pull related memories
  if (cfg.graphWeight > 0) {
    const topIds = [...scoreMap.entries()]
      .sort((a, b) => {
        const aScore = a[1].vectorScore * cfg.vectorWeight + a[1].ftsScore * cfg.textWeight;
        const bScore = b[1].vectorScore * cfg.vectorWeight + b[1].ftsScore * cfg.textWeight;
        return bScore - aScore;
      })
      .slice(0, 5)
      .map(([id]) => id);

    for (const seedId of topIds) {
      const related = db.getRelatedMemoryIds(seedId, 2);
      for (const relatedId of related) {
        if (!scoreMap.has(relatedId)) {
          getEntry(relatedId).graphScore = 0.5;
        } else {
          getEntry(relatedId).graphScore = Math.max(getEntry(relatedId).graphScore, 0.3);
        }
      }
    }
  }

  // 4. Merge scores
  const { vectorWeight, textWeight, graphWeight } = cfg;
  const totalWeight = vectorWeight + textWeight + graphWeight;

  type ScoredItem = { id: string; score: number; primarySource: "vector" | "fts" | "graph" };
  const merged: ScoredItem[] = [];
  for (const [id, scores] of scoreMap) {
    const combined =
      (scores.vectorScore * vectorWeight +
        scores.ftsScore * textWeight +
        scores.graphScore * graphWeight) /
      totalWeight;

    if (combined < minScore) continue;

    const primarySource: "vector" | "fts" | "graph" =
      scores.vectorScore >= scores.ftsScore && scores.vectorScore >= scores.graphScore
        ? "vector"
        : scores.ftsScore >= scores.graphScore
          ? "fts"
          : "graph";

    merged.push({ id, score: combined, primarySource });
  }

  // 5. Sort by score descending
  merged.sort((a, b) => b.score - a.score);

  // 6. MMR diversity re-ranking (simple — skip very similar consecutive results)
  const diversified = mmrRerank(merged, maxResults);

  // 7. Hydrate results
  const results: SearchResult[] = [];
  for (const item of diversified) {
    const memory = db.getMemory(item.id);
    if (!memory) continue;
    if (memory.is_superseded && !options?.includeSuperseded) continue;

    db.bumpAccessCount(item.id);
    results.push({
      memory,
      score: item.score,
      source: item.primarySource,
    });
  }

  return results.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// MMR diversity re-ranking (simplified)
// ---------------------------------------------------------------------------

function mmrRerank(
  items: Array<{ id: string; score: number; primarySource: "vector" | "fts" | "graph" }>,
  limit: number,
  lambda = 0.7,
): typeof items {
  if (items.length <= limit) return items;

  const selected: typeof items = [];
  const remaining = [...items];

  // Always include the top result
  if (remaining.length > 0) {
    selected.push(remaining.shift()!);
  }

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      // Penalize items from the same source as recently selected
      const lastSelected = selected[selected.length - 1];
      const diversity = lastSelected?.primarySource === remaining[i].primarySource ? 0.8 : 1.0;
      const mmrScore = lambda * relevance + (1 - lambda) * diversity;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Extract keywords for FTS-only mode
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "i", "me", "my",
  "we", "our", "you", "your", "he", "she", "it", "they", "them",
  "what", "which", "who", "when", "where", "why", "how", "that", "this",
  "and", "or", "but", "if", "then", "else", "for", "of", "to", "in",
  "on", "at", "by", "with", "from", "about", "into", "not", "no",
]);

export function extractSearchKeywords(query: string): string {
  return query
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
    .join(" ");
}
