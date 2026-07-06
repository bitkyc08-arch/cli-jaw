// Physical directory sandboxing and post-dispatch scope verification.
// Uses only Node.js built-ins — no new dependencies.

import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const PROTECTED_PATTERNS = [
    /\.git\//,
    /\.env$/,
    /settings\.json$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
];

function isPathWithin(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function listGitChangedFiles(projectRoot: string): string[] {
    // Runs only after scoped dispatch/checkpoint actions, not in the steady request hot path.
    const outputs = [
        execSync('git diff --name-only', { cwd: projectRoot }).toString(),
        execSync('git diff --cached --name-only', { cwd: projectRoot }).toString(),
        execSync('git ls-files --others --exclude-standard', { cwd: projectRoot }).toString(),
    ];
    return [...new Set(outputs.flatMap(output => output.split('\n').filter(Boolean)))];
}

export function normalizeScope(projectRoot: string, scopePath: string): string {
    const resolvedRoot = path.resolve(projectRoot);
    const resolvedScope = path.resolve(projectRoot, scopePath);

    if (!isPathWithin(resolvedScope, resolvedRoot)) {
        throw new Error(`Security Error: Scope [${scopePath}] escapes project root.`);
    }

    if (fs.existsSync(resolvedScope)) {
        const realRoot = fs.realpathSync(resolvedRoot);
        const realScope = fs.realpathSync(resolvedScope);
        if (!isPathWithin(realScope, realRoot)) {
            throw new Error(`Security Error: Realpath of scope is outside project root.`);
        }
    }

    return resolvedScope;
}

export function isProtectedPath(filePath: string): boolean {
    return PROTECTED_PATTERNS.some(regex => regex.test(filePath));
}

export function postDispatchDiffCheck(
    projectRoot: string, allowedScope?: string,
): { ok: boolean; modifiedOutside: string[] } {
    if (!allowedScope) return { ok: true, modifiedOutside: [] };

    const modifiedFiles = listGitChangedFiles(projectRoot);

    const absoluteAllowedScope = path.resolve(projectRoot, allowedScope);
    const outsideFiles = modifiedFiles.filter(file => {
        const absFile = path.resolve(projectRoot, file);
        return !isPathWithin(absFile, absoluteAllowedScope) || isProtectedPath(file);
    });

    return {
        ok: outsideFiles.length === 0,
        modifiedOutside: outsideFiles,
    };
}
