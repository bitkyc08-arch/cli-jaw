/**
 * Shared Claude install classification.
 * Used by both doctor.ts and install.sh (via node -e) to determine
 * whether the user's Claude CLI is a native or npm/bun-managed install.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ClaudeInstallKind = 'native' | 'node-managed' | 'unknown';

export function classifyClaudeInstall(binaryPath: string | null): ClaudeInstallKind {
    if (!binaryPath) return 'unknown';

    const nativeDirs = [
        path.join(os.homedir(), '.local', 'bin', 'claude'),
        path.join(os.homedir(), '.claude', 'local', 'bin', 'claude'),
    ];
    if (nativeDirs.includes(binaryPath)) return 'native';

    try {
        const real = fs.realpathSync(binaryPath);
        if (real.includes(`${path.sep}node_modules${path.sep}@anthropic-ai${path.sep}claude-code${path.sep}`)) {
            return 'node-managed';
        }
        if (real.includes(`${path.sep}.claude${path.sep}local${path.sep}`)) return 'native';
    } catch {
        // best-effort classification only
    }

    if (binaryPath.includes(`${path.sep}.bun${path.sep}bin${path.sep}claude`)) return 'node-managed';
    return 'unknown';
}
