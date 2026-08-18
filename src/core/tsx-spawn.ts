/**
 * Source-mode tsx spawn resolution (#381).
 *
 * node_modules/.bin/tsx is a trap on Windows: existsSync matches the
 * extensionless POSIX shim, which spawn() cannot execute (ENOENT), while
 * tsx.cmd needs a shell and swallows signals. Running tsx's JS entry through
 * the current Node avoids shims entirely and keeps signal forwarding intact.
 *
 * --env-file is a Node flag, so it must precede the tsx entry in argv.
 */
import { createRequire } from 'node:module';

export type TsxSpawnSpec = { command: string; args: string[] };

export function resolveTsxSpawn(
    projectRoot: string,
    serverPath: string,
    envFile: string | null,
    deps: { resolveTsxEntry?: (root: string) => string | null; execPath?: string } = {},
): TsxSpawnSpec {
    const resolveEntry = deps.resolveTsxEntry ?? defaultResolveTsxEntry;
    const execPath = deps.execPath ?? process.execPath;
    const nodeFlags = envFile ? [`--env-file=${envFile}`] : [];
    const entry = resolveEntry(projectRoot);
    if (entry) return { command: execPath, args: [...nodeFlags, entry, serverPath] };
    // Last resort: a global tsx on PATH (posix shells resolve it; Windows
    // users in source mode always have node_modules, so this stays rare).
    return { command: 'tsx', args: [...nodeFlags.map(f => f), serverPath] };
}

function defaultResolveTsxEntry(root: string): string | null {
    try {
        const req = createRequire(root.endsWith('/') || root.endsWith('\\') ? root : root + '/');
        return req.resolve('tsx/cli');
    } catch { return null; }
}
