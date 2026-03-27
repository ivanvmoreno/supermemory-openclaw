// Minimal type stub for node:sqlite (experimental API, Node >= 22.5)
// Full types may be available in @types/node >= 22.x but are not guaranteed.

declare module "node:sqlite" {
	export class DatabaseSync {
		constructor(path: string, options?: Record<string, unknown>)
		exec(sql: string): void
		prepare(sql: string): StatementSync
		close(): void
	}

	export interface StatementSync {
		run(...params: unknown[]): unknown
		get(...params: unknown[]): unknown
		all(...params: unknown[]): unknown[]
	}
}
