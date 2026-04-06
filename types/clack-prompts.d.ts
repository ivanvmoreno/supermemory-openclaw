// Type stubs for @clack/prompts.

declare module "@clack/prompts" {
	export function intro(title?: string): void
	export function outro(message?: string): void
	export function isCancel(value: unknown): value is symbol
	export function cancel(message?: string): void
	export function note(message?: string, title?: string): void

	export type TextOptions = {
		message: string
		placeholder?: string
		initialValue?: string
		validate?: (value: string) => string | undefined
	}
	export function text(options: TextOptions): Promise<string | symbol>

	export type PasswordOptions = {
		message: string
		validate?: (value: string) => string | undefined
	}
	export function password(options: PasswordOptions): Promise<string | symbol>

	export type ConfirmOptions = {
		message: string
		initialValue?: boolean
	}
	export function confirm(options: ConfirmOptions): Promise<boolean | symbol>

	export type SelectOption<T> = {
		value: T
		label: string
		hint?: string
	}
	export type SelectOptions<T> = {
		message: string
		options: SelectOption<T>[]
		initialValue?: T
	}
	export function select<T>(options: SelectOptions<T>): Promise<T | symbol>

	export type Spinner = {
		start(message?: string): void
		stop(message?: string): void
	}
	export function spinner(): Spinner

	export const log: {
		info(message: string): void
		warn(message: string): void
		error(message: string): void
		success(message: string): void
		step(message: string): void
	}
}
