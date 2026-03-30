# LongMemEval Integration Assets

- `run.ts` is the local OpenClaw integration battery entrypoint.
- `fixtures/oracle.json` is the bundled LongMemEval fixture used by default.
- Use `--data-file` for any larger or custom LongMemEval artifact that should stay outside the repo.
- The exposed CLI is intentionally small: `--preset` (`smoke` or `full`), `--limit`, `--data-file`, `--keep-profile`, `--run-official-eval`, and `--official-repo`.
- Generated outputs are written under `.tmp/tests/integration/longmemeval/`.
- The runner auto-loads repo-root `.env.local` and `.env` before reading env defaults.
- Start from the repo-root [.env.sample](/Users/ivan/repos/supermemory-openclaw/.env.sample) when creating a local env file.
- Supported env defaults: `LONGMEMEVAL_SOURCE_STATE_DIR` and `LONGMEMEVAL_OFFICIAL_REPO`.
- Model and embedding settings are derived from the source OpenClaw config plus `OPENAI_API_KEY`/auth-profiles fallback when needed.
- If you need a narrower subset than `smoke`, point `--data-file` at a pre-filtered LongMemEval artifact instead of expecting more runner presets.
- Use `--run-official-eval` when you want actual LongMemEval scoring.
- `--run-official-eval` shells out to `python3` on `PATH`; on this machine a Python 3.11 environment with `httpx<0.28` is the known-good evaluator setup.
