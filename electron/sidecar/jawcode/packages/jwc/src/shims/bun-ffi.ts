/**
 * `bun:ffi` alias stub (100.07). Only packages/tui touches FFI (ttyid /
 * terminal console API) and both call sites already catch failures and keep
 * startup non-fatal (terminal.ts:257). The stub therefore throws lazily at
 * call time instead of breaking the bundle import.
 */

function ffiUnavailable(): never {
	throw new Error("bun:ffi is unavailable in the jwc Node bundle");
}

export function dlopen(..._args: unknown[]): never {
	ffiUnavailable();
}

export function ptr(..._args: unknown[]): never {
	ffiUnavailable();
}

export class CString {
	constructor(..._args: unknown[]) {
		ffiUnavailable();
	}
}

export const FFIType = new Proxy(
	{},
	{
		get: (_target, prop) => `ffi:${String(prop)}`,
	},
) as Record<string, unknown>;

export const suffix = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
