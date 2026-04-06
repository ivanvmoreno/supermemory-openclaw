import type { SemanticLogger } from "./semantic-runtime.ts";

export type PluginLogger = SemanticLogger & {
  error: (msg: string, err?: unknown) => void;
  debug: (msg: string) => void;
};

export function createPluginLogger(base: SemanticLogger, name: string, isDebug: boolean): PluginLogger {
  const p = `[${name}]`;
  return {
    info: (msg) => base.info(`${p} ${msg}`),
    warn: (msg) => base.warn(`${p} ${msg}`),
    error: (msg, err?: unknown) => {
      const detail = err instanceof Error ? err.message : err != null ? String(err) : "";
      base.warn(`${p} ${msg}${detail ? ` — ${detail}` : ""}`);
    },
    debug: isDebug ? (msg) => base.info(`${p} [debug] ${msg}`) : _noop,
  };
}

function _noop(_msg: string): void {}
