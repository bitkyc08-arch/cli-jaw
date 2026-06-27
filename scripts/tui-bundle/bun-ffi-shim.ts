// `bun:ffi` is unavailable on Node. The TUI only uses it for optional terminal
// probes that already degrade when FFI is missing, so a no-op shim is enough.
export function dlopen(_path: string, _symbols: Record<string, unknown>): unknown {
	return { symbols: {}, close() {} };
}
export const ptr = (_value: unknown): number => 0;
export const CString = String;
export const FFIType: Record<string, number> = new Proxy({}, { get: () => 0 });
