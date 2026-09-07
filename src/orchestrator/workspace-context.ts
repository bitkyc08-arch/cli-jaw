import { existsSync, realpathSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

const REPO_PATH_PREFIXES = [
    'src/',
    'public/',
    'tests/',
    'scripts/',
    'devlog/',
    'skills/',
    'skills_ref/',
    'package.json',
    'tsconfig.json',
];

export type WorkspaceContextInput = {
    workingDir?: string | null;
    projectDirs?: string[] | null;
    worklogPath?: string | null;
    employeeName?: string | null;
    task?: string;
    now?: Date;
};

export function resolveWorkspaceRoot(workingDir?: string | null): string {
    return resolve(workingDir || process.cwd());
}

const MAX_PATH_HINT_TOKENS = 30;
const MAX_TOKEN_LENGTH = 256;
const MAX_HINT_LINES = 100;

export function buildResolvedPathHints(task: string | undefined, projectRoots: string[]): string {
    if (!task || projectRoots.length === 0) return '';
    const seen = new Set<string>();
    const words = task.match(/[A-Za-z0-9_./@-]+/g) || [];
    for (const word of words) {
        const clean = word.replace(/[),.;:]+$/, '');
        if (clean.length > MAX_TOKEN_LENGTH) continue;
        if (!REPO_PATH_PREFIXES.some(prefix => clean === prefix || clean.startsWith(prefix))) continue;
        seen.add(clean);
        if (seen.size >= MAX_PATH_HINT_TOKENS) break;
    }
    if (!seen.size) return '';
    const lines: string[] = [];
    for (const p of seen) {
        if (lines.length >= MAX_HINT_LINES) break;
        if (p.includes('..')) continue;
        for (const root of projectRoots) {
            if (lines.length >= MAX_HINT_LINES) break;
            const absolute = resolve(root, p);
            const rel = relative(root, absolute);
            if (rel.startsWith('..') || rel.startsWith(sep + sep)) continue;
            let status = 'not found';
            if (existsSync(absolute)) {
                try {
                    const real = realpathSync.native(absolute);
                    const realRel = relative(root, real);
                    status = (realRel.startsWith('..') || realRel.startsWith(sep + sep)) ? 'symlink-outside' : 'exists';
                } catch { status = 'not found'; }
            }
            lines.push(`- ${p} -> ${JSON.stringify(absolute)} (${status})`);
        }
    }
    return `## Resolved Path Hints\n${lines.join('\n')}`;
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

function formatOffset(minutesEastOfUtc: number): string {
    const sign = minutesEastOfUtc >= 0 ? '+' : '-';
    const abs = Math.abs(minutesEastOfUtc);
    return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function formatLocalTimestamp(date: Date): string {
    const offset = formatOffset(-date.getTimezoneOffset());
    return [
        date.getFullYear(),
        '-',
        pad2(date.getMonth() + 1),
        '-',
        pad2(date.getDate()),
        'T',
        pad2(date.getHours()),
        ':',
        pad2(date.getMinutes()),
        ':',
        pad2(date.getSeconds()),
        offset,
    ].join('');
}

function runtimeTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    } catch {
        return 'local';
    }
}

export function buildWorkspaceContextBlock(input: WorkspaceContextInput): string {
    const roots = input.projectDirs?.length
        ? input.projectDirs.map(d => resolve(d))
        : [resolveWorkspaceRoot(input.workingDir)];

    const rootLines = roots.length === 1
        ? `Project root: ${JSON.stringify(roots[0])}`
        : roots.map((r, i) => `Project root ${i + 1}: ${JSON.stringify(r)}`).join('\n');

    const hints = buildResolvedPathHints(input.task, roots);
    const now = input.now || new Date();

    return [
        '## Workspace Context (authoritative)',
        rootLines,
        `Current time: ${formatLocalTimestamp(now)}`,
        `Timezone: ${runtimeTimezone()}`,
        `UTC time: ${now.toISOString()}`,
        `Worklog path: ${input.worklogPath || '(none)'}`,
        'Employee runtime cwd: isolated temporary directory, not the project root',
        '',
        'Path rules:',
        '- Treat Project root as the source of truth.',
        '- Resolve all relative repository paths against Project root.',
        '- Use absolute paths when reading or editing files.',
        '- Use the explicit Worklog path for execution records; follow project policy for any other planning or evidence location.',
        '- Do not invent a log directory under Project root. If project policy requires external private records, keep them outside the public repository.',
        '- Do not infer repository paths from process.cwd(), ~/.cli-jaw, or the employee temp directory.',
        '- If a requested path is missing under Project root, stop and report it instead of guessing.',
        hints ? `\n${hints}` : '',
    ].filter(Boolean).join('\n');
}
