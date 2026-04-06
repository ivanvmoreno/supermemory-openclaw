# 🧠 Supermemory OpenClaw Plugin

Local graph-based memory plugin for [OpenClaw](https://github.com/nichochar/openclaw) — inspired by [Supermemory](https://supermemory.ai). Runs entirely on your machine with no cloud dependencies.

> **Disclaimer:** This is an independent project. It is not affiliated with, endorsed by, or maintained by the Supermemory team. The name reflects architectural inspiration, not a partnership.

## How It Works

- **Auto-capture** — After each AI response, an LLM subagent extracts typed atomic memories (facts, episodes, preferences) and raw entity mentions from the turn, deduplicates them lexically and by vector similarity, then stores them in a local SQLite knowledge graph.
- **Graph storage** — Memories are linked to canonical entities and connected by relationship edges: `updates` (newer fact supersedes older) and `related` (connected facts sharing entities).
- **Background maintenance** — A periodic job merges entity aliases (e.g. "Ivan" / "Iván"), expires stale episodic memories, and backfills any missing embeddings.
- **Auto-recall** — Before each AI turn, hybrid search (BM25 + vector + graph hops) retrieves the most relevant memories and your user profile, which are injected into the prompt context.

Sequence diagrams available in [`docs/diagrams/`](docs/diagrams/).

## Quick Start

### Step 1: Install the plugin

```bash
openclaw plugins install openclaw-memory-supermemory
```

### Step 2: Configure OpenClaw

Edit `~/.openclaw/openclaw.json` and add the plugin entry:

```json5
{
  "plugins": {
    "allow": ["openclaw-memory-supermemory"],
    "entries": {
      "openclaw-memory-supermemory": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai",
            "model": "text-embedding-3-small",
            "apiKey": "${OPENAI_API_KEY}"
          }
        }
      }
    }
  }
}
```

### Step 3: Restart OpenClaw

Restart the OpenClaw gateway for the plugin to load.

### Step 4: Verify it works

```bash
openclaw supermemory stats
```

You should see output like:

```
Total memories:      0
Active memories:     0
Superseded memories: 0
Entities:            0
Relationships:       0
```

Zero counts are normal on first run.

## Embedding Providers

Supported providers and auto-detected dimensions:

| Model | Provider | Dimensions |
|-------|----------|-----------|
| `nomic-embed-text` | Ollama | 768 |
| `text-embedding-3-small` | OpenAI | 1536 |
| `text-embedding-3-large` | OpenAI | 3072 |
| `mxbai-embed-large` | Ollama | 1024 |
| `all-minilm` | Ollama | 384 |
| `snowflake-arctic-embed` | Ollama | 1024 |

Set `provider` to `"ollama"` or `"openai"`. Any OpenAI-compatible endpoint also works via `baseUrl`. For unlisted models, set `embedding.dimensions` explicitly.

## AI Tools

The AI uses these tools autonomously:

| Tool | Description |
|------|-------------|
| `memory_search` | Search across memories using vector + keyword + graph retrieval when embeddings are enabled, otherwise keyword + graph (or keyword-only if `graphWeight` is 0) |
| `memory_store` | Save information with automatic entity extraction and relationship detection |
| `memory_forget` | Delete memories by ID or search query |
| `memory_profile` | View/rebuild the automatically maintained user profile |

## CLI Commands

```bash
openclaw supermemory configure          # Interactive setup wizard
openclaw supermemory status             # Show current configuration
openclaw supermemory stats              # Show memory statistics
openclaw supermemory search <query>     # Search memories
openclaw supermemory search "<term>" --limit 5
openclaw supermemory profile            # View user profile
openclaw supermemory profile --rebuild  # Force rebuild profile
openclaw supermemory wipe --confirm     # Wipe persisted memory data and re-initialize storage
```

### Interactive Setup

Run `openclaw supermemory configure` for a guided wizard that reads your existing `~/.openclaw/openclaw.json` and writes the plugin entry back after prompting for:

- Plugin enabled/disabled
- Auto-capture and auto-recall toggles
- Embedding provider, model, API key, and base URL
- Custom database path

Run `openclaw supermemory status` at any time to print a summary of the current configuration.

Run `openclaw supermemory wipe --confirm` to wipe the SQLite memory store and re-initialize an empty database without changing your saved plugin configuration.

## Slash Commands

Three slash commands are registered for quick in-chat memory access:

| Command | Description |
|---------|-------------|
| `/remember <text>` | Store a memory immediately, bypassing auto-capture |
| `/recall <query>` | Run a hybrid search and display matching memories |
| `/forget <description>` | Delete a memory by description; auto-deletes on high-confidence single match, otherwise lists candidates |

## Vector Search

The plugin always uses FTS5 keyword search. When `graphWeight > 0`, it also augments results with graph traversal. When embeddings are enabled, it additionally uses `sqlite-vec` for vector similarity search and vector-based deduplication.

Because `sqlite-vec` is bundled with OpenClaw's built-in memory system, the plugin automatically detects and loads the extension from the host environment when embeddings are enabled. This means vector similarity search is usually available out-of-the-box without requiring any additional installation or configuration.

If you prefer to avoid embedding work entirely, set `embedding.enabled: false` in your configuration. That disables embedding generation, vector retrieval, and vector-based deduplication while preserving any existing stored vectors on disk.

When you turn embeddings back on later, the plugin starts a background backfill. It reindexes any stored vectors first, then embeds older active memories that were captured while embeddings were disabled. Startup is not blocked while this runs.

## Configuration Reference

All settings are optional. The plugin now exposes only the operational knobs that still affect behavior directly.

### Core

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.enabled` | boolean | `true` | Enable or disable embedding generation, vector retrieval, and vector deduplication |
| `embedding.provider` | string | `"ollama"` | Embedding provider (`ollama`, `openai`, etc.) |
| `embedding.model` | string | `"nomic-embed-text"` | Embedding model name |
| `embedding.apiKey` | string | — | API key (cloud providers only, supports `${ENV_VAR}` syntax) |
| `embedding.baseUrl` | string | — | Custom API base URL |
| `embedding.dimensions` | number | auto | Vector dimensions (auto-detected for known models) |
| `autoCapture` | boolean | `true` | Auto-capture memories from conversations |
| `captureMode` | string | `"extract"` | `"extract"` (LLM semantic extraction) or `"off"` (disable auto-capture) |
| `autoRecall` | boolean | `true` | Auto-inject memories + profile into context |
| `dbPath` | string | `~/.openclaw/memory/supermemory.db` | SQLite database path |
| `debug` | boolean | `false` | Enable verbose logging |

### Profile And Prompt

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `profileFrequency` | number | `50` | Rebuild the profile every N interactions |
| `maxLongTermItems` | number | `20` | Max memories included in the long-term profile section |
| `maxRecentItems` | number | `10` | Max memories included in the recent profile section |
| `recentWindowDays` | number | `7` | How many days count as recent for episodic memories |
| `profileScanLimit` | number | `1000` | Max active memories scanned when rebuilding the profile |
| `promptMemoryMaxChars` | number | `500` | Max characters per memory item when injecting profile or recall context |

### Recall And Search

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRecallResults` | number | `10` | Max results returned by the `memory_search` tool. Auto-recall uses a separate cap. |
| `vectorWeight` | number | `0.5` | Weight for vector similarity in hybrid search |
| `textWeight` | number | `0.3` | Weight for BM25 keyword search |
| `graphWeight` | number | `0.2` | Weight for graph-augmented retrieval |
| `minScore` | number | `0.1` | Minimum combined score for a result to be returned |
| `vectorMinScoreFactor` | number | `0.5` | Multiplied by `minScore` to set the vector search cut-off (effective floor: `minScore × vectorMinScoreFactor`) |
| `graphSeedLimit` | number | `5` | Number of top-scored results used to seed the graph hop walk |
| `graphHopDepth` | number | `2` | Depth of graph traversal per seed node |
| `mmrLambda` | number | `0.7` | MMR trade-off between relevance (`1.0`) and diversity (`0.0`) in result re-ranking |
| `autoRecallMaxMemories` | number | `5` | Hard cap on memories injected into the prompt during auto-recall (independent of `maxRecallResults`) |
| `autoRecallMinScore` | number | `0.3` | Minimum score for a memory to be injected during auto-recall |

### Capture And Extraction

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `captureMaxChars` | number | `2000` | Max characters from the assembled conversation turn sent to auto-capture extraction |
| `extractorMaxItems` | number | `10` | Max memories the LLM extractor may return per conversation turn |

### Relationships And Forgetting

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `forgetExpiredIntervalMinutes` | number | `60` | Minutes between forgetting cleanup runs |
| `temporalDecayDays` | number | `90` | Days before stale unpinned episodic memories decay |
| `nearDuplicateThreshold` | number | `0.95` | Vector cosine similarity above which an incoming memory is treated as a near-duplicate and skipped |
| `lexicalDuplicateThreshold` | number | `0.88` | Lexical overlap score above which an incoming memory is treated as a lexical duplicate and skipped |
| `updateVectorMinScore` | number | `0.55` | Minimum vector similarity for a candidate memory to be considered for an `updates` relationship |
| `maxRelatedEdges` | number | `5` | Maximum number of `related` graph edges written per memory on ingestion |

## Semantic Extraction

The plugin uses your configured LLM to extract typed atomic memories, raw entity mentions, and temporal metadata from each conversation turn.

**Input conversation:**
> "Caught up with Iván today. He's working at Santander as an AI Scientist now, doing research on knowledge graphs. He lives in Madrid and mentioned a deadline next Tuesday for a paper submission."

**Extracted memories:**

- `fact`: Iván works at Santander as an AI Scientist
- `fact`: Iván researches knowledge graphs
- `fact`: Iván lives in Madrid
- `episode`: Iván has a paper submission deadline next Tuesday

Each extracted memory is stored separately with:

- a `memoryType` (`fact`, `preference`, or `episode`)
- raw entity mentions such as `Iván`, `Santander`, and `Madrid`
- optional temporal metadata such as `expiresAtIso`

Those raw mentions are linked to canonical entities later, so the system can preserve original surface forms while still grouping aliases over time.

Set `captureMode: "off"` to disable auto-capture entirely.

## Architecture

> **For an in-depth breakdown of the graph logic, scoring algorithms, and background processes, see the following [document](./docs/memory.md).**

```
openclaw-memory-supermemory/
├── index.ts                    # Plugin entry
├── openclaw.plugin.json        # Plugin manifest (kind: "memory")
├── tests/
│   └── integration/
│       └── longmemeval/
│           ├── fixtures/       # Bundled LongMemEval test artifacts
│           ├── README.md       # Test layout and artifact notes
│           └── run.ts          # Local OpenClaw integration battery / benchmark runner
├── src/
│   ├── config.ts               # Config parsing + defaults
│   ├── db.ts                   # SQLite: memories, canonical entities, aliases, relationships, profiles
│   ├── embeddings.ts           # Ollama + OpenAI-compatible embedding providers
│   ├── fact-extractor.ts       # LLM semantic extraction + relationship/entity resolvers
│   ├── graph-engine.ts         # Storage orchestration, alias linking, update resolution
│   ├── entity-text.ts          # Entity alias normalization helpers
│   ├── semantic-runtime.ts     # Shared subagent runtime helpers for JSON tasks
│   ├── memory-text.ts          # Injected/synthetic memory filtering and prompt-safe sanitization
│   ├── search.ts               # Hybrid search (vector + FTS5 + graph)
│   ├── profile-builder.ts      # Long-term + recent user profile
│   ├── forgetting.ts           # Expiration, stale-episode cleanup, deferred entity merging
│   ├── tools.ts                # Agent tools (search, store, forget, profile)
│   ├── hooks.ts                # Auto-recall + guarded auto-capture hooks
│   ├── cli.ts                  # CLI commands + slash command registration
│   ├── configure.ts            # Interactive setup wizard + status command
│   └── logger.ts               # Named, debug-aware plugin logger
```

### Storage

All data stored in a single SQLite database:

- **memories** — Text, embeddings, memory type, expiration, access tracking, `pinned`, `parent_memory_id`
- **entities** — Canonical entity clusters
- **entity_aliases** — Raw observed entity names / surface forms
- **entity_mentions** — Links between memories and aliases
- **relationships** — Graph edges (`updates` / `related`)
- **profile_cache** — Cached long-term + recent user profile
- **memories_fts** — FTS5 virtual table for keyword search
- **memories_vec** — sqlite-vec virtual table for vector similarity (if enabled)

## LongMemEval Integration

The repo includes a [LongMemEval](https://github.com/xiaowu0162/LongMemEval) runner that evaluates this plugin through a real local OpenClaw agent invocation while keeping benchmark state isolated from your normal `~/.openclaw` profile.

```bash
# One example per main LongMemEval category + one abstention case
bun run test:integration:longmemeval

# Run the whole bundled oracle fixture
bun run test:integration:longmemeval --preset full

# Run the official LongMemEval evaluator afterwards
bun run test:integration:longmemeval --run-official-eval --official-repo /tmp/LongMemEval
```

The runner auto-loads repo-root `.env.local` and `.env` before reading env defaults. Start from [.env.sample](.env.sample).

What the runner does:

1. Uses the bundled oracle fixture by default, or a file passed via `--data-file`
2. Creates an isolated `~/.openclaw-<profile>` profile
3. Copies auth and model metadata from `LONGMEMEVAL_SOURCE_STATE_DIR` (default: `~/.openclaw`)
4. Imports each benchmark instance into a fresh plugin DB
5. Asks the benchmark question through `openclaw agent --local`
6. Writes a `predictions.jsonl` file plus a run summary JSON
