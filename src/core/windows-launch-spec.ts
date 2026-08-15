import { existsSync, readFileSync } from 'node:fs';
import { win32 as pathWin32 } from 'node:path';

/**
 * Resolve a Windows launch target without a command interpreter (#367).
 *
 * The problem: Node enables `shell: true` for any non-.exe command on Windows, and
 * several runtimes place the prompt directly in argv. That routes untrusted text
 * through cmd.exe parsing, where `& | < > ^ ( ) % !` stop being literal data.
 *
 * Quoting is the wrong fix. cmd.exe quoting is not CommandLineToArgvW quoting, `%VAR%`
 * expands even with delayed expansion disabled, and the ~8191-character ceiling means
 * no encoder can carry a long prompt. So we remove the shell instead: resolve the npm
 * .cmd shim to the script it runs and the interpreter that runs it, then spawn that
 * interpreter directly with shell: false.
 */
export type LaunchSpec = {
    /** The interpreter to execute, or the binary itself when resolvedVia is 'direct'. */
    command: string;
    /** The script the interpreter runs; null for a direct executable. */
    target: string | null;
    /** Interpreter arguments from the shebang, ordered BEFORE the target. */
    baseArgs: string[];
    /** The caller's argv, passed through untouched and never re-parsed. */
    userArgs: string[];
    /** Environment assignments from an `env -S FOO=bar` shebang. */
    envDelta: Record<string, string>;
    useShell: false;
    resolvedVia: 'direct' | 'shim-target';
};

export type ShebangInfo = {
    interpreter: string;
    args: string[];
    envDelta: Record<string, string>;
};

type ResolveDeps = {
    readFile?: (path: string) => string;
    exists?: (path: string) => boolean;
};

const WINDOWS_SHIM_EXTENSIONS = ['.cmd', '.bat'];

/**
 * Extract the target path from an npm cmd-shim.
 *
 * This regex is npm's own, copied from `read-cmd-shim/lib/index.js` (extractPathFromCmd)
 * so that our understanding of the format cannot drift from the tool that writes it.
 * Hand-rolling this is a trap: real shims wrap the call in an `_prog`/`endLocal`
 * structure, so a naive `node "…" %*` matcher returns null for every npm-installed CLI
 * and would make every Windows CLI unlaunchable.
 *
 * The capture is layout-agnostic — it takes whatever follows `dp0`, which covers both
 * the global (`%dp0%\node_modules\pkg\…`) and local (`%dp0%\..\pkg\…`) shapes.
 */
export function extractCmdShimTarget(shimText: string): string | null {
    const matched = shimText.match(/"%(?:~dp0|dp0%)\\([^"]+?)"\s+%[*]/);
    return matched ? (matched[1] ?? null) : null;
}

/**
 * Parse a shebang line into interpreter, arguments, and env assignments.
 *
 * The target is NOT always Node. Observed in a real install: `claude-e` resolves to
 * `#!/usr/bin/env sh` and `cursor-agent` to `#!/usr/bin/env bash`. Assuming node here
 * would launch a shell script with the wrong interpreter.
 */
export function parseShebang(targetText: string): ShebangInfo | null {
    const firstLine = targetText.split(/\r?\n/, 1)[0] ?? '';
    if (!firstLine.startsWith('#!')) return null;

    const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;

    let interpreter = tokens.shift()!;
    const envDelta: Record<string, string> = {};

    // `#!/usr/bin/env [-S] [VAR=value ...] real-interpreter [args]`
    if (/(^|[\\/])env$/.test(interpreter)) {
        if (tokens[0] === '-S' || tokens[0] === '--split-string') tokens.shift();
        while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
            const assignment = tokens.shift()!;
            const splitAt = assignment.indexOf('=');
            envDelta[assignment.slice(0, splitAt)] = assignment.slice(splitAt + 1);
        }
        if (!tokens.length) return null;
        interpreter = tokens.shift()!;
    }

    return { interpreter, args: tokens, envDelta };
}

function isShim(command: string): boolean {
    const lowered = command.toLowerCase();
    return WINDOWS_SHIM_EXTENSIONS.some(ext => lowered.endsWith(ext));
}

/**
 * Build a shell-free launch plan.
 *
 * Spawn exactly:
 *   spawn(spec.command, [...spec.baseArgs, ...(spec.target ? [spec.target] : []), ...spec.userArgs],
 *         { shell: false, env: { ...env, ...spec.envDelta } })
 *
 * Returns null when the command cannot be launched without a shell. That is deliberate:
 * failing closed with an actionable message is the point of #367, so there is no
 * cmd.exe fallback to quietly fall back into.
 */
export function resolveWindowsLaunchSpec(
    command: string,
    args: string[],
    deps: ResolveDeps = {},
    depth = 0,
): LaunchSpec | null {
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const exists = deps.exists ?? existsSync;

    if (!isShim(command)) {
        return { command, target: null, baseArgs: [], userArgs: args, envDelta: {}, useShell: false, resolvedVia: 'direct' };
    }

    // One level of indirection is legitimate (a shim whose interpreter is itself a
    // shim). Beyond that, stop rather than chase a possible cycle.
    if (depth > 1) return null;

    let shimText: string;
    try {
        shimText = readFile(command);
    } catch {
        return null;
    }

    const relativeTarget = extractCmdShimTarget(shimText);
    if (!relativeTarget) return null;

    // Shim targets are Windows-shaped even when this runs on macOS in tests, so resolve
    // with the win32 semantics rather than the host's.
    const target = pathWin32.resolve(pathWin32.dirname(command), relativeTarget);
    if (!exists(target)) return null;

    let targetText: string;
    try {
        targetText = readFile(target);
    } catch {
        return null;
    }

    const shebang = parseShebang(targetText);
    if (!shebang) return null;

    if (isShim(shebang.interpreter)) {
        const nested = resolveWindowsLaunchSpec(shebang.interpreter, args, deps, depth + 1);
        if (!nested) return null;
        return {
            ...nested,
            target,
            baseArgs: [...nested.baseArgs, ...(nested.target ? [nested.target] : []), ...shebang.args],
            envDelta: { ...nested.envDelta, ...shebang.envDelta },
            resolvedVia: 'shim-target',
        };
    }

    return {
        command: shebang.interpreter,
        target,
        baseArgs: shebang.args,
        userArgs: args,
        envDelta: shebang.envDelta,
        useShell: false,
        resolvedVia: 'shim-target',
    };
}

/** Final argv for a resolved spec, in the one correct order. */
export function launchArgv(spec: LaunchSpec): string[] {
    return [...spec.baseArgs, ...(spec.target ? [spec.target] : []), ...spec.userArgs];
}

