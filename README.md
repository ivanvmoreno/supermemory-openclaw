# OpenClaw Memory (Supermemory Local)

Local graph-based memory plugin for [OpenClaw](https://github.com/nichochar/openclaw) — inspired by [Supermemory](https://supermemory.ai). Runs entirely on your machine with no cloud dependencies.

## Features

- **Graph Memory** — Automatic entity extraction (people, projects, emails) and relationship tracking (updates / extends / derives)
- **User Profiles** — Static long-term facts + dynamic recent context, automatically maintained and injected into system prompt
- **Automatic Forgetting** — Temporal expiration for time-bound facts, decay for low-importance unused memories, contradiction resolution
- **Hybrid Search** — BM25 keyword (FTS5) + graph-augmented multi-hop retrieval with MMR diversity re-ranking. Vector similarity (sqlite-vec) used when available.
- **Auto-Recall** — Injects relevant memories + user profile before every AI turn.
- **OpenClaw Runtime Integration** — Registers memory tools, a built-in memory search manager, and a pre-compaction memory flush plan when the host API supports them.
- **Fully Local** — SQLite storage, no external dependencies (cloud embeddings optional).

## Quick Start

### Step 1: Install the plugin

```bash
openclaw plugins install openclaw-memory-supermemory
```

### Step 2: Configure OpenClaw

Edit `~/.openclaw/openclaw.json` and add **both** the memory slot and the plugin entry:

```json5
{
  plugins: {
    // REQUIRED: Assign this plugin to the memory slot
    slots: {
      memory: "openclaw-memory-supermemory"
    },
    // RECOMMENDED: Suppress the auto-load security warning
    allow: ["openclaw-memory-supermemory"],
    // Plugin configuration
    entries: {
      "openclaw-memory-supermemory": {
        enabled: true,
        config: {
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
            apiKey: "${OPENAI_API_KEY}"    // reads from env var
          },
          autoRecall: true,
          autoCapture: true
        }
      }
    }
  }
}
```

> **Important:** The `slots.memory` line is required — without it, OpenClaw won't use the plugin even if it's installed.

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
Vector search:       unavailable
```

Zero counts are normal on first run. `Vector search: unavailable` is expected — see [Vector Search](#vector-search) below.

## Embedding Providers

You need an embedding provider for semantic search. Choose one:

### OpenAI (recommended for simplicity)

```json5
embedding: {
  provider: "openai",
  model: "text-embedding-3-small",
  apiKey: "${OPENAI_API_KEY}"
}
```

Set the environment variable before starting OpenClaw:

```bash
export OPENAI_API_KEY="sk-..."
```

### Ollama (fully local, no API key)

Install [Ollama](https://ollama.ai) and pull a model:

```bash
ollama pull nomic-embed-text
```

```json5
embedding: {
  provider: "ollama",
  model: "nomic-embed-text"
}
```

### Other OpenAI-compatible providers

Any provider with an OpenAI-compatible `/v1/embeddings` endpoint works:

```json5
embedding: {
  provider: "openai",
  model: "your-model-name",
  apiKey: "${YOUR_API_KEY}",
  baseUrl: "https://your-provider.com/v1"
}
```

### Supported models (auto-detected dimensions)

| Model | Provider | Dimensions |
|-------|----------|-----------|
| `nomic-embed-text` | Ollama | 768 |
| `text-embedding-3-small` | OpenAI | 1536 |
| `text-embedding-3-large` | OpenAI | 3072 |
| `mxbai-embed-large` | Ollama | 1024 |
| `all-minilm` | Ollama | 384 |
| `snowflake-arctic-embed` | Ollama | 1024 |

For other models, set `embedding.dimensions` explicitly.

## How It Works

1. **You talk to your AI normally.** Share preferences, mention projects, discuss problems.
2. **Auto-capture** extracts important facts from your messages — preferences, decisions, entities, project context.
   It only considers the last real user turn and strips any memory/profile blocks that were injected into prompt context.
3. **Graph engine** links memories via entities and detects relationships:
   - **Updates** — "I moved to SF" supersedes "I live in NYC"
   - **Extends** — "I lead a team of 5" enriches "I'm a PM at Stripe"
   - **Derives** — Inferred connections from shared entities
4. **Auto-recall** injects your user profile + relevant memories before each AI turn.
5. **Automatic forgetting** cleans up expired time-bound facts and decays unused low-importance memories.

## AI Tools

The AI uses these tools autonomously:

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid search across all memories (vector + keyword + graph) |
| `memory_store` | Save information with automatic entity extraction and relationship detection |
| `memory_forget` | Delete memories by ID or search query |
| `memory_profile` | View/rebuild the automatically maintained user profile |

## CLI Commands

```bash
openclaw supermemory stats              # Show memory statistics
openclaw supermemory search <query>     # Search memories
openclaw supermemory search "rust" --limit 5
openclaw supermemory profile            # View user profile
openclaw supermemory profile --rebuild  # Force rebuild profile
openclaw supermemory wipe --confirm     # Delete all memories
```

## Verifying Memories

After chatting with the AI, you can verify memories are being captured:

```bash
# Check memory counts increased
openclaw supermemory stats

# Search for something you mentioned
openclaw supermemory search "your topic"

# View your auto-built profile
openclaw supermemory profile
```

## Vector Search

The plugin uses FTS5 keyword search + graph traversal by default. Vector similarity search requires `sqlite-vec`, which is bundled with OpenClaw's built-in memory system but not automatically available to external plugins.

If your OpenClaw build includes `sqlite-vec`, the plugin will detect and use it automatically.

## Troubleshooting

### "plugins.allow is empty" warning

Suppress it by adding:

```json5
plugins: {
  allow: ["openclaw-memory-supermemory"]
}
```

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.provider` | string | `"ollama"` | Embedding provider (`ollama`, `openai`, etc.) |
| `embedding.model` | string | `"nomic-embed-text"` | Embedding model name |
| `embedding.apiKey` | string | — | API key (cloud providers only, supports `${ENV_VAR}` syntax) |
| `embedding.baseUrl` | string | — | Custom API base URL |
| `embedding.dimensions` | number | auto | Vector dimensions (auto-detected for known models) |
| `autoCapture` | boolean | `true` | Auto-capture memories from conversations |
| `autoRecall` | boolean | `true` | Auto-inject memories + profile into context |
| `profileFrequency` | number | `50` | Rebuild user profile every N interactions |
| `entityExtraction` | string | `"pattern"` | Current implementation is pattern-based. `"llm"` is reserved and currently behaves the same as `"pattern"`. |
| `forgetExpiredIntervalMinutes` | number | `60` | Minutes between forgetting cleanup runs |
| `temporalDecayDays` | number | `90` | Days before low-importance unused memories decay |
| `maxRecallResults` | number | `10` | Max memories injected per auto-recall |
| `vectorWeight` | number | `0.5` | Weight for vector similarity in hybrid search |
| `textWeight` | number | `0.3` | Weight for BM25 keyword search |
| `graphWeight` | number | `0.2` | Weight for graph-augmented retrieval |
| `dbPath` | string | `~/.openclaw/memory/supermemory.db` | SQLite database path |
| `captureMaxChars` | number | `2000` | Max message length for auto-capture |
| `debug` | boolean | `false` | Enable verbose logging |

## Architecture

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
│   ├── db.ts                   # SQLite: memories, entities, relationships, profiles
│   ├── embeddings.ts           # Ollama + OpenAI-compatible embedding providers
│   ├── graph-engine.ts         # Entity extraction, relationship detection
│   ├── memory-text.ts          # Injected/synthetic memory filtering and prompt-safe sanitization
│   ├── search.ts               # Hybrid search (vector + FTS5 + graph)
│   ├── profile-builder.ts      # Static + dynamic user profile
│   ├── forgetting.ts           # Temporal decay, expiration, cleanup
│   ├── tools.ts                # Agent tools (search, store, forget, profile)
│   ├── hooks.ts                # Auto-recall + guarded auto-capture hooks
│   └── cli.ts                  # CLI commands
```

### Storage

All data stored in a single SQLite database:

- **memories** — Text, embeddings, importance, category, expiration, access tracking
- **entities** — Extracted entities (people, projects, tech, emails, URLs)
- **entity_mentions** — Links between memories and entities
- **relationships** — Graph edges (updates / extends / derives)
- **profile_cache** — Cached static + dynamic user profile
- **memories_fts** — FTS5 virtual table for keyword search
- **memories_vec** — sqlite-vec virtual table for vector similarity (when available)

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

The runner auto-loads repo-root `.env.local` and `.env` before reading env defaults. Start from [.env.sample](/Users/ivan/repos/supermemory-openclaw/.env.sample). The only supported runner env defaults are `LONGMEMEVAL_SOURCE_STATE_DIR` and `LONGMEMEVAL_OFFICIAL_REPO`.

What the runner does:

1. Uses the bundled oracle fixture by default, or a file passed via `--data-file`
2. Creates an isolated `~/.openclaw-<profile>` profile
3. Copies auth and model metadata from `LONGMEMEVAL_SOURCE_STATE_DIR` (default: `~/.openclaw`)
4. Imports each benchmark instance into a fresh plugin DB
5. Asks the benchmark question through `openclaw agent --local`
6. Writes a `predictions.jsonl` file plus a run summary JSON
