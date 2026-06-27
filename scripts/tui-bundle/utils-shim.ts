// Minimal Node replacements for the handful of @jawcode-dev/utils helpers the
// TUI bundle references. Keeps winston / handlebars / mermaid and the rest of
// the utils package out of a bundle meant to run on plain Node.
export function getDefaultTabWidth(): number { return 4; }
export function getIndentation(): string { return "  "; }
export function $flag(_name: string): boolean { return false; }
export function $env(key: string): string | undefined { return process.env[key]; }
export function getDebugLogPath(): string | null { return null; }
export function getProjectDir(): string { return process.cwd(); }
export function getLogsDir(): string { return process.cwd(); }
export const logger = { info() {}, warn() {}, error() {}, debug() {} };
