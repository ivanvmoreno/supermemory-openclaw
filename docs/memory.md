# Memory Architecture

## 1. Data Model

At its core, the memory system is an SQLite-backed knowledge graph that distinguishes between raw text, semantic concepts, and relationships. The database schema encompasses the following key entities:

*   **Memories (`memories`)**: The atomic unit of storage. Each memory contains:
    *   `text`: The raw text of the memory (e.g., "Iván lives in Madrid").
    *   `memory_type`: Categorized as `fact` (enduring truth), `preference` (user preference), or `episode` (time-bound event).
    *   `vector`: An optional float array representing the embedding for semantic search.
    *   `is_superseded`: A boolean flag (0/1) indicating if a newer memory has replaced this one.
    *   `pinned`: A boolean flag protecting the memory from automatic decay.
    *   `parent_memory_id`: Links an updated memory back to the memory it superseded.
    *   `access_count` & `last_accessed_at`: Tracking metrics used for profile building and forgetting.
*   **Entities & Aliases (`entities`, `entity_aliases`)**: To handle the reality that people and concepts are referred to in various ways (e.g., "Iván", "Ivan", "he"), the system uses a dual-layer approach:
    *   **Entity Aliases (`entity_aliases`)**: Represents the exact surface text found in a conversation. Every unique string mention is an alias.
    *   **Canonical Entities (`entities`)**: Represents the underlying "real-world" concept. Aliases map to a single canonical entity. Over time, background processes can merge separate canonical entities if they are determined to be the same concept.
*   **Mentions (`entity_mentions`)**: A junction table linking a `memory` to an `entity_alias`.
*   **Relationships (`relationships`)**: Directed edges between memories (`source_id` -> `target_id`). Currently supports two `relation_type`s:
    *   `updates`: The source memory replaces/corrects the target memory.
    *   `related`: The memories share meaningful semantic context but neither supersedes the other.

## 2. Ingestion & Extraction Pipeline

The process of taking a conversation turn and converting it into structured memories happens primarily via the `autoCapture` hook.

### LLM Semantic Extraction
When a user and assistant complete a turn, the conversation text is cleaned of "synthetic" markers (like injected prompt contexts) to prevent the LLM from memorizing its own system prompts.
The cleaned text is sent to an LLM subagent (`fact-extractor.ts`) with a strict JSON schema prompt. The LLM is instructed to:
1. Extract discrete atomic facts, preferences, and episodes.
2. Identify entities within those memories, preserving their original surface text.
3. Resolve relative time expressions (e.g., "next Tuesday") to absolute ISO-8601 timestamps using a provided reference time, specifically for `episode` types.

### Deduplication & Storage
Before storing a newly extracted memory (`graph-engine.ts`), the system performs deduplication checks:
1.  **Exact Match**: It checks for an exact case-insensitive text match. If found, it merges metadata (bumping access counts, updating expiration) instead of creating a duplicate.
2.  **Near Duplicate (Lexical Fallback)**: Before embedding, it runs an FTS-backed lexical dedup pass. Candidate memories are scored with accent-folded token containment, token-order overlap (LCS), and character trigram Dice similarity. This pass uses a multilingual stopword filter (`stopwords-iso`) covering over 55 languages to ensure the lexical scoring is based strictly on content tokens, correctly identifying true duplicates globally without being skewed by common grammatical words. This catches duplicates caused by punctuation, accent changes, or light wording edits even when embeddings are unavailable.
3.  **Near Duplicate (Vector)**: If vector embeddings are available, it computes the embedding and performs a similarity search. If a memory has a cosine similarity >= `0.95` (`NEAR_DUPLICATE_VECTOR_THRESHOLD`), it is treated as a duplicate; its access count is bumped, and the new memory is discarded.

If embedding generation fails, the memory is still stored without a vector instead of dropping the write entirely. Retrieval then falls back to keyword + graph search until vectors are available again.

### Entity Linking
Mentions extracted by the LLM are normalized. The system checks the `entity_aliases` table. If the normalized text exists, the memory is linked to the existing alias and its canonical entity. If not, a new canonical entity and alias are created.

### Relationship Resolution
If the memory is a `fact` or `preference`, the system attempts to determine if it updates an older memory (`resolveUpdateRelationship`).
1.  **Candidate Generation**: It queries the database for memories sharing the same canonical entities and (if vectors are available) memories with high vector similarity (>= `0.55`).
2.  **LLM Evaluation**: These candidates are sent to the LLM subagent, which decides if the new memory `updates` a candidate, is merely `related`, or has `none` (no relationship).
3.  **Superseding**: If an `updates` relationship is found, an edge is created, the new memory records the old memory's ID in `parent_memory_id`, and the old memory is marked `is_superseded = 1`.

Finally, deterministic `related` edges are created for up to 5 older memories that share the highest number of canonical entities with the new memory.

## 3. Retrieval & Hybrid Search

The `memory_search` tool and the auto-recall hook utilize a hybrid search algorithm (`search.ts`) that combines Vector Similarity, Keyword Match (FTS5), and Graph Traversal.

### Scoring Algorithm
The hybrid search assigns a combined score to each candidate memory based on configured weights (`vectorWeight`, `textWeight`, `graphWeight`):

```javascript
combinedScore = (vectorScore * vw + ftsScore * fw + graphScore * gw) / (vw + fw + gw)
```

1.  **Vector Search (if available via `sqlite-vec`)**: Computes the query embedding and retrieves top results. Scores are normalized based on cosine distance.
2.  **FTS Search (Keyword)**: Uses SQLite FTS5 `MATCH`. Scores are normalized based on the absolute `rank` relative to the highest-ranked result.
3.  **Graph Augmentation**: The system identifies the top "seed" memories from the combined Vector + FTS scores. It then traverses the `relationships` table up to 2 hops deep (`GRAPH_HOP_DEPTH`). Discovered related memories are assigned a `graphScore` (`0.5` if newly discovered, `0.3` if already found via FTS/Vector).

### MMR Diversity Re-ranking
To prevent the search results from being dominated by highly similar memories (e.g., repeating the same fact slightly differently), the system applies a simplified Maximal Marginal Relevance (MMR) re-ranking.
As it selects the top results, it penalizes candidate memories that share the same "primary source" (the highest contributing score type: vector, FTS, or graph) as the most recently selected memory. This ensures a diverse mix of semantically similar, keyword-exact, and graph-related context.

### Filtering
By default, superseded memories (`is_superseded = 1`) are completely excluded from search results.

## 4. Profile Building & Auto-Recall

Before the AI generates a response, the `autoRecall` hook injects relevant context into the system prompt.

### The User Profile
The `profile-builder.ts` maintains a cached snapshot of the user's most relevant context, split into two sections:
*   **Long-Term**: Contains `pinned` memories, `fact`s, and `preference`s. It prioritizes memories that are pinned, frequently accessed (`access_count`), and recently updated.
*   **Recent Context**: Contains `episode`s that occurred within a sliding window (default: last 7 days).

The profile is rebuilt periodically based on interaction counts or a time-to-live expiration.

### Auto-Recall Injection
When a user sends a message:
1.  The User Profile is retrieved.
2.  A hybrid search is executed using the user's prompt as the query to find contextually relevant memories not already in the profile.
3.  Both the Profile and the Search Results are formatted and injected as `<supermemory-context>` blocks at the end of the system prompt.
4.  Crucially, `memory-text.ts` ensures that these injected synthetic blocks are stripped out during the next auto-capture phase, preventing an infinite loop of the AI memorizing its own injected memories.

## 5. Forgetting & Entity Merging

The `ForgettingService` (`forgetting.ts`) runs periodically in the background to keep the database clean and organized.

### 1. Hard Expiration
Memories with an explicit `expires_at` timestamp (usually `episode`s extracted with an `expiresAtIso` by the LLM) are permanently deleted once the time passes.

### 2. Chronological Decay
Unpinned `episode` memories that have never been accessed (`access_count = 0`) and are older than `temporalDecayDays` (default 90 days) are considered "stale" and permanently deleted.

### 3. Background Entity Merging
To handle scenarios where the LLM creates slightly different canonical entities for the same concept (e.g., "John Doe" vs "John D."), the system performs deferred merging:
1.  **Candidate Selection**: It fetches the most recently seen canonical entities and computes their embeddings.
2.  **Pre-filtering**: It compares every pair. A pair is considered a candidate for merging only if their string similarity (Jaccard index of tokens + loose accent folding) is >= `0.74` OR their cosine similarity is >= `0.86`.
3.  **LLM Resolution**: High-scoring pairs are sent to the LLM subagent, which makes a definitive `same` or `different` decision.
4.  **Merge Execution**: If `same`, the newer entity is merged into the older entity. The `merged_into_id` pointer is set, and all `entity_aliases` are repointed to the surviving entity. Subsequent queries for the lost entity transparently resolve to the survivor.
