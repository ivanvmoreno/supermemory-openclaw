# OpenClaw Memory (Supermemory Local)

Local graph-based memory plugin for [OpenClaw](https://github.com/nichochar/openclaw) — inspired by [Supermemory](https://supermemory.ai). Runs entirely on your machine with no cloud dependencies.

## Features

- **Graph Memory** — Automatic entity extraction (people, projects, emails) and relationship tracking (updates / extends / derives)
- **User Profiles** — Static long-term facts + dynamic recent context, automatically maintained and injected into system prompt
- **Automatic Forgetting** — Temporal expiration for time-bound facts, decay for low-importance unused memories, contradiction resolution
- **Hybrid Search** — Vector similarity (sqlite-vec) + BM25 keyword (FTS5) + graph-augmented multi-hop retrieval with MMR diversity re-ranking
- **Auto-Recall** — Injects relevant memories + user profile before every AI turn
- **Auto-Capture** — Extracts and stores important information from conversations automatically
- **Fully Local** — SQLite storage + Ollama embeddings, zero cloud dependencies

## Install

```bash
openclaw plugins install openclaw-memory-supermemory
```

Restart OpenClaw after installing.

## Setup

### Prerequisites

For local embeddings, install [Ollama](https://ollama.ai) and pull a model:

```bash
ollama pull nomic-embed-text
```

### Configuration

Add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    slots: {
      memory: "openclaw-memory-supermemory"
    },
    entries: {
      "openclaw-memory-supermemory": {
        enabled: true,
        config: {
          // Embedding (defaults to Ollama + nomic-embed-text)
          embedding: {
            provider: "ollama",
            model: "nomic-embed-text"
          },
          // Behavior
          autoRecall: true,
          autoCapture: true
        }
      }
    }
  }
}
```

### Using OpenAI Embeddings Instead

```json5
{
  plugins: {
    entries: {
      "openclaw-memory-supermemory": {
        config: {
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
            apiKey: "${OPENAI_API_KEY}"
          }
        }
      }
    }
  }
}
```

## How It Works

1. **You talk to your AI normally.** Share preferences, mention projects, discuss problems.
2. **Auto-capture** extracts important facts from your messages — preferences, decisions, entities, project context.
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
openclaw supermemory search <query>     # Search memories
openclaw supermemory profile            # View user profile
openclaw supermemory profile --rebuild  # Force rebuild profile
openclaw supermemory stats              # Show memory statistics
openclaw supermemory wipe --confirm     # Delete all memories
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.provider` | string | `"ollama"` | Embedding provider (`ollama`, `openai`, etc.) |
| `embedding.model` | string | `"nomic-embed-text"` | Embedding model name |
| `embedding.apiKey` | string | — | API key (cloud providers only) |
| `embedding.baseUrl` | string | — | Custom API base URL |
| `embedding.dimensions` | number | auto | Vector dimensions (auto-detected for known models) |
| `autoCapture` | boolean | `true` | Auto-capture memories from conversations |
| `autoRecall` | boolean | `true` | Auto-inject memories + profile into context |
| `profileFrequency` | number | `50` | Rebuild user profile every N interactions |
| `entityExtraction` | string | `"pattern"` | `"pattern"` (fast regex) or `"llm"` |
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
├── src/
│   ├── config.ts               # Config parsing + defaults
│   ├── db.ts                   # SQLite: memories, entities, relationships, profiles
│   ├── embeddings.ts           # Ollama + OpenAI-compatible embedding providers
│   ├── graph-engine.ts         # Entity extraction, relationship detection
│   ├── search.ts               # Hybrid search (vector + FTS5 + graph)
│   ├── profile-builder.ts      # Static + dynamic user profile
│   ├── forgetting.ts           # Temporal decay, expiration, cleanup
│   ├── tools.ts                # Agent tools (search, store, forget, profile)
│   ├── hooks.ts                # Auto-recall + auto-capture hooks
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

## Publishing

### First-time setup (bootstrap)

npm Trusted Publishing requires the package to exist before you can configure it. For a brand-new package:

1. Create a classic npm token (Automation type) at https://www.npmjs.com/settings/~/tokens
2. Add it as a repository secret: **Settings → Secrets → `NPM_TOKEN`**
3. Go to **Actions → "Bootstrap: First npm publish" → Run workflow**
   - Set version (e.g. `0.1.0`), run with dry-run first to verify, then run for real
4. After it succeeds, go to **npmjs.com → package settings → Trusted Publishers**
   - Click **GitHub Actions**
   - Set: repository owner, repository name, workflow filename: `release.yml`
5. **Delete the `NPM_TOKEN` secret** — it's no longer needed
6. Disable or delete the bootstrap workflow

### Subsequent releases (automated)

All releases after the bootstrap use **OIDC trusted publishing** — no tokens to manage:

```bash
# Tag a release
git tag v0.2.0
git push origin v0.2.0
```

This triggers `release.yml` which:
1. **Validates** — typechecks, lints, validates plugin manifest
2. **Publishes to ClawHub** — via `clawhub` CLI (requires `CLAWHUB_TOKEN` secret)
3. **Publishes to npm** — via OIDC trusted publishing (no secret needed)
4. **Creates GitHub Release** — with zip archive and auto-generated release notes

### Required secrets

| Secret | Purpose | When needed |
|--------|---------|-------------|
| `NPM_TOKEN` | Bootstrap first npm publish only | Delete after first publish |
| `CLAWHUB_TOKEN` | ClawHub plugin registry auth | All releases |
