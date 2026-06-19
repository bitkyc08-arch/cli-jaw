import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readdir as readDir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { hasReservedNoteSegment, NOTES_RESERVED_DIRS } from './constants.js';
import { isPathInside, NOTE_FILE_EXT, notePathError } from './path-guards.js';

export type NoteSearchResult = {
    path: string;
    line: number;
    content: string;
    context: string;
    kind: 'path' | 'content';
};

export type SearchNotesOptions = {
    limit?: number;
    regex?: boolean;
    ripgrepPath?: string;
    timeoutMs?: number;
    spawnImpl?: typeof spawn;
};

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 500;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_COUNT_PER_FILE = 3;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const RIPGREP_ENV_PATH = 'CLI_JAW_RIPGREP_PATH';

function parseLimit(input: number | undefined): number {
    if (input === undefined) return DEFAULT_LIMIT;
    if (!Number.isFinite(input) || input < 1 || input > MAX_LIMIT) {
        throw notePathError(400, 'invalid_note_search_limit', `search limit must be between 1 and ${MAX_LIMIT}`);
    }
    return Math.floor(input);
}

function reservedGlobArgs(): string[] {
    return [...NOTES_RESERVED_DIRS].flatMap(dir => ['--glob', `!**/${dir}/**`]);
}

function normalizeResultPath(root: string, rawPath: string): string | null {
    const absolute = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
    if (!isPathInside(root, absolute)) return null;
    const rel = relative(root, absolute).split(sep).join('/').replaceAll('\\', '/');
    if (!rel || rel.startsWith('../') || rel === '..') return null;
    if (!rel.endsWith(NOTE_FILE_EXT)) return null;
    if (hasReservedNoteSegment(rel)) return null;
    return rel;
}

function pathMatchesQuery(path: string, query: string): boolean {
    const normalizedQuery = query.toLocaleLowerCase();
    const normalizedPath = path.toLocaleLowerCase();
    const filename = posix.basename(normalizedPath, NOTE_FILE_EXT);
    return normalizedPath.includes(normalizedQuery) || filename.includes(normalizedQuery);
}

async function collectPathMatches(root: string, query: string, limit: number): Promise<NoteSearchResult[]> {
    const results: NoteSearchResult[] = [];
    async function walk(relativeDir: string): Promise<void> {
        if (results.length >= limit) return;
        const absoluteDir = resolve(root, relativeDir);
        let entries;
        try {
            entries = await readDir(absoluteDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (results.length >= limit) return;
            const childPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
            if (hasReservedNoteSegment(childPath)) continue;
            if (entry.isDirectory()) {
                await walk(childPath);
                continue;
            }
            if (!entry.isFile() || !childPath.endsWith(NOTE_FILE_EXT)) continue;
            if (!pathMatchesQuery(childPath, query)) continue;
            results.push({
                path: childPath,
                line: 0,
                content: childPath,
                context: childPath,
                kind: 'path',
            });
        }
    }
    await walk('');
    return results;
}

function rgArgs(query: string, regex: boolean): string[] {
    const args = [
        '--no-config',
        '--json',
        '--max-count',
        String(MAX_COUNT_PER_FILE),
        '--ignore-case',
        '--no-messages',
        '--hidden',
        '--no-ignore',
        '--glob',
        `*${NOTE_FILE_EXT}`,
        ...reservedGlobArgs(),
    ];
    if (!regex) args.push('--fixed-strings');
    args.push('--regexp', query);
    return args;
}

function ripgrepBinaryName(): string {
    return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function bundledRipgrepRoots(): string[] {
    return [
        join(homedir(), '.bun', 'install', 'global', 'node_modules', '@openai'),
        join(homedir(), '.npm-global', 'lib', 'node_modules', '@openai'),
    ];
}

function findBundledRipgrep(): string | null {
    const binary = ripgrepBinaryName();
    for (const root of bundledRipgrepRoots()) {
        if (!existsSync(root)) continue;
        try {
            const packages = readdirSync(root, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && entry.name.startsWith('codex-'));
            for (const pkg of packages) {
                const vendorRoot = join(root, pkg.name, 'vendor');
                if (!existsSync(vendorRoot)) continue;
                for (const target of readdirSync(vendorRoot, { withFileTypes: true })) {
                    if (!target.isDirectory()) continue;
                    const candidate = join(vendorRoot, target.name, 'path', binary);
                    if (existsSync(candidate)) return candidate;
                }
            }
        } catch {
            continue;
        }
    }
    return null;
}

export function resolveRipgrepCommand(): string {
    const configured = process.env[RIPGREP_ENV_PATH]?.trim();
    if (configured) return configured;
    return findBundledRipgrep() || 'rg';
}

function pushMatch(root: string, rawLine: string, results: NoteSearchResult[], limit: number, skipPaths: Set<string>): void {
    if (results.length >= limit || !rawLine.trim()) return;
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawLine) as unknown;
    } catch {
        return;
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { type?: unknown }).type !== 'match') return;
    const data = (parsed as { data?: Record<string, unknown> }).data;
    const pathText = (data?.["path"] as { text?: unknown } | undefined)?.text;
    if (typeof pathText !== 'string') return;
    const relPath = normalizeResultPath(root, pathText);
    if (!relPath) return;
    if (skipPaths.has(relPath)) return;
    const lineNumber = typeof data?.["line_number"] === 'number' ? data["line_number"] : 0;
    const lineText = (data?.["lines"] as { text?: unknown } | undefined)?.text;
    const content = typeof lineText === 'string' ? lineText.trim() : '';
    results.push({
        path: relPath,
        line: lineNumber,
        content,
        context: content.slice(0, 200),
        kind: 'content',
    });
}

export function buildRipgrepArgs(query: string, root: string, regex = false): string[] {
    return [...rgArgs(query, regex), root];
}

export async function searchNotes(
    root: string,
    rawQuery: string,
    options: SearchNotesOptions = {},
): Promise<NoteSearchResult[]> {
    const query = rawQuery.trim();
    if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
        throw notePathError(
            400,
            'invalid_note_search_query',
            `search query must be between ${MIN_QUERY_LENGTH} and ${MAX_QUERY_LENGTH} characters`,
        );
    }
    const limit = parseLimit(options.limit);
    const run = options.spawnImpl || spawn;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pathResults = await collectPathMatches(root, query, limit);
    const results: NoteSearchResult[] = [...pathResults];
    const pathMatched = new Set(pathResults.map(result => result.path));
    if (results.length >= limit) return results;
    const args = buildRipgrepArgs(query, root, Boolean(options.regex));
    const command = options.ripgrepPath || resolveRipgrepCommand();

    return await new Promise<NoteSearchResult[]>((resolvePromise, rejectPromise) => {
        const child = run(command, args, {
            shell: false,
            env: { ...process.env, RIPGREP_CONFIG_PATH: '' },
        });
        let settled = false;
        let outputBytes = 0;
        let stderr = '';
        let lineBuffer = '';
        let killedForLimit = false;
        const finish = (error?: unknown, value?: NoteSearchResult[]): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) rejectPromise(error);
            else resolvePromise(value || results);
        };
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish(notePathError(504, 'notes_search_timeout', 'notes search timed out'));
        }, timeoutMs);

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', chunk => {
            if (settled) return;
            const text = String(chunk);
            outputBytes += Buffer.byteLength(text);
            if (outputBytes > MAX_OUTPUT_BYTES) {
                child.kill('SIGTERM');
                finish(notePathError(413, 'notes_search_output_too_large', 'notes search output was too large'));
                return;
            }
            lineBuffer += text;
            let newline = lineBuffer.indexOf('\n');
            while (newline >= 0) {
                pushMatch(root, lineBuffer.slice(0, newline), results, limit, pathMatched);
                lineBuffer = lineBuffer.slice(newline + 1);
                if (results.length >= limit) {
                    killedForLimit = true;
                    child.kill('SIGTERM');
                    finish(undefined, results);
                    return;
                }
                newline = lineBuffer.indexOf('\n');
            }
        });
        child.stderr?.on('data', chunk => {
            stderr += String(chunk);
            if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
                child.kill('SIGTERM');
                finish(notePathError(413, 'notes_search_output_too_large', 'notes search output was too large'));
            }
        });
        child.on('error', error => {
            const typed = error as NodeJS.ErrnoException;
            if (typed.code === 'ENOENT') {
                finish(notePathError(501, 'notes_search_unavailable', 'ripgrep (rg) is not installed'));
                return;
            }
            finish(error);
        });
        child.on('close', code => {
            if (settled) return;
            if (lineBuffer) pushMatch(root, lineBuffer, results, limit, pathMatched);
            if (killedForLimit || code === 0) {
                finish(undefined, results);
                return;
            }
            if (code === 1) {
                finish(undefined, []);
                return;
            }
            if (code === 2 && /regex parse error/i.test(stderr)) {
                finish(notePathError(400, 'invalid_note_search_regex', stderr.split(/\r?\n/u).find(Boolean) || 'invalid regex'));
                return;
            }
            if (code === 2) {
                finish(undefined, results);
                return;
            }
            finish(notePathError(500, 'notes_search_failed', stderr.split(/\r?\n/u).find(Boolean) || `ripgrep exited with code ${code}`));
        });
    });
}
