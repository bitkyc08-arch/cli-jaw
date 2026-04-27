import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
    worklogPath?: string | null;
    employeeName?: string | null;
    task?: string;
};

export function resolveWorkspaceRoot(workingDir?: string | null): string {
    return resolve(workingDir || process.cwd());
}

export function buildResolvedPathHints(task: string | undefined, projectRoot: string): string {
    if (!task) return '';
    const seen = new Set<string>();
    const words = task.match(/[A-Za-z0-9_./@-]+/g) || [];
    for (const word of words) {
        const clean = word.replace(/[),.;:]+$/, '');
        if (!REPO_PATH_PREFIXES.some(prefix => clean === prefix || clean.startsWith(prefix))) continue;
        seen.add(clean);
    }
    if (!seen.size) return '';
    const lines = [...seen].map(path => {
        const absolute = join(projectRoot, path);
        const status = existsSync(absolute) ? 'exists' : 'not found';
        return `- ${path} -> ${absolute} (${status})`;
    });
    return `## Resolved Path Hints\n${lines.join('\n')}`;
}

export function buildWorkspaceContextBlock(input: WorkspaceContextInput): string {
    const projectRoot = resolveWorkspaceRoot(input.workingDir);
    const devlogRoot = join(projectRoot, 'devlog');
    const hints = buildResolvedPathHints(input.task, projectRoot);

    return [
        '## Workspace Context (authoritative)',
        `Project root: ${projectRoot}`,
        `Devlog root: ${devlogRoot}`,
        `Worklog path: ${input.worklogPath || '(none)'}`,
        'Employee runtime cwd: isolated temporary directory, not the project root',
        '',
        'Path rules:',
        '- Treat Project root as the source of truth.',
        '- Resolve all relative repository paths against Project root.',
        '- Use absolute paths when reading or editing files.',
        '- Do not infer repository paths from process.cwd(), ~/.cli-jaw, or the employee temp directory.',
        '- If a requested path is missing under Project root, stop and report it instead of guessing.',
        hints ? `\n${hints}` : '',
    ].filter(Boolean).join('\n');
}
