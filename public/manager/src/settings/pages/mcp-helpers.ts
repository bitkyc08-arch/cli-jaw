// Phase 8 — pure helpers for the MCP page. Exported so the unit tests can
// drive env/args round-tripping, server validation, and config normalization
// without mounting React.
//
// The unified MCP config shape is `{ servers: Record<string, McpServer>, ... }`.
// We accept extra top-level keys and round-trip them untouched so we never
// silently drop fields the runtime added later (e.g. `disabledServers`).

export type McpServer = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    autostart?: boolean;
    [key: string]: unknown;
};

export type McpConfig = {
    servers: Record<string, McpServer>;
    [key: string]: unknown;
};

// Server name = filesystem-safe ID. We don't enforce a closed token set, but
// we forbid whitespace, slashes and shell metacharacters that would corrupt
// downstream sync (Claude/Codex/Cline configs all use the name as a key).
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function isValidServerName(name: string): boolean {
    if (typeof name !== 'string') return false;
    if (name.length === 0 || name.length > 64) return false;
    return NAME_RE.test(name);
}

export function normalizeMcpConfig(raw: unknown): McpConfig {
    if (!raw || typeof raw !== 'object') return { servers: {} };
    const obj = raw as Record<string, unknown>;
    const serversRaw = obj['servers'];
    const servers: Record<string, McpServer> = {};
    if (serversRaw && typeof serversRaw === 'object' && !Array.isArray(serversRaw)) {
        for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
            servers[name] = normalizeServer(value);
        }
    }
    return { ...obj, servers };
}

export function normalizeServer(raw: unknown): McpServer {
    if (!raw || typeof raw !== 'object') return { command: '' };
    const r = raw as Record<string, unknown>;
    const command = typeof r['command'] === 'string' ? r['command'] : '';
    const args = Array.isArray(r['args'])
        ? r['args'].filter((v): v is string => typeof v === 'string')
        : undefined;
    const env =
        r['env'] && typeof r['env'] === 'object' && !Array.isArray(r['env'])
            ? Object.fromEntries(
                Object.entries(r['env'] as Record<string, unknown>).filter(
                    (entry): entry is [string, string] =>
                        typeof entry[1] === 'string',
                ),
            )
            : undefined;
    const autostart = typeof r['autostart'] === 'boolean' ? r['autostart'] : undefined;
    const out: McpServer = { command };
    if (args && args.length > 0) out.args = args;
    if (env && Object.keys(env).length > 0) out.env = env;
    if (autostart !== undefined) out.autostart = autostart;
    // Preserve any unknown extras so the runtime can keep evolving the schema.
    for (const [k, v] of Object.entries(r)) {
        if (k === 'command' || k === 'args' || k === 'env' || k === 'autostart') continue;
        out[k] = v;
    }
    return out;
}

export function makeEmptyServer(): McpServer {
    return { command: '' };
}

// Args round-tripping: prefer one-arg-per-line. We accept comma-separated
// input on edit too — pasted command lines like `-y @upstash/context7-mcp`
// shouldn't require manual newlining. Empty tokens are dropped.
export function formatArgsText(args: ReadonlyArray<string> | undefined): string {
    if (!args || args.length === 0) return '';
    return args.join('\n');
}

export function parseArgsText(text: string): string[] {
    if (!text) return [];
    const parts = text.split(/\r?\n|,/);
    const out: string[] = [];
    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.length > 0) out.push(trimmed);
    }
    return out;
}

// Env parser: accept `KEY=value` lines. Blank lines and `#` comments are
// ignored. Keys must match POSIX-ish env-name rules so a typo can't smuggle
// shell-special chars into a child process.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvText(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text) return out;
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1);
        if (!ENV_KEY_RE.test(key)) continue;
        out[key] = value;
    }
    return out;
}

export function formatEnvText(
    env: Record<string, string> | undefined,
): string {
    if (!env) return '';
    return Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
}

export type ServerValidation =
    | { kind: 'ok' }
    | { kind: 'invalid'; reason: string };

export function validateServer(name: string, server: McpServer): ServerValidation {
    if (!isValidServerName(name)) {
        return {
            kind: 'invalid',
            reason: 'Server name must match [a-zA-Z0-9._-] (1–64 chars).',
        };
    }
    if (!server.command || server.command.trim() === '') {
        return { kind: 'invalid', reason: 'Command is required.' };
    }
    return { kind: 'ok' };
}

export function findDuplicateNames(
    names: ReadonlyArray<string>,
): Set<string> {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const name of names) {
        const lower = name.toLowerCase();
        if (seen.has(lower)) dupes.add(lower);
        else seen.add(lower);
    }
    return dupes;
}

/**
 * Strip empty optional fields before sending to /api/mcp PUT so saved JSON
 * stays minimal and matches what loadUnifiedMcp would produce after a
 * round-trip. Preserves unknown extras.
 */
export function toPersistShape(config: McpConfig): McpConfig {
    const servers: Record<string, McpServer> = {};
    for (const [name, srv] of Object.entries(config.servers)) {
        const out: McpServer = { command: srv.command };
        if (srv.args && srv.args.length > 0) out.args = [...srv.args];
        if (srv.env && Object.keys(srv.env).length > 0) {
            out.env = { ...srv.env };
        }
        if (srv.autostart !== undefined) out.autostart = srv.autostart;
        for (const [k, v] of Object.entries(srv)) {
            if (k === 'command' || k === 'args' || k === 'env' || k === 'autostart') continue;
            out[k] = v;
        }
        servers[name] = out;
    }
    return { ...config, servers };
}

export function newServerName(existing: ReadonlyArray<string>): string {
    let i = 1;
    while (existing.includes(`server-${i}`)) i += 1;
    return `server-${i}`;
}
