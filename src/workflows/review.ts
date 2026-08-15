import path from 'node:path';
import { settings } from '../core/config.js';
import { JAW_HOME } from '../core/config.js';
import type { WorkflowArtifact } from '../cli/types.js';
import {
    createWorkflowArtifactId,
    createWorkflowStorage,
    projectKeyFromPath,
} from './artifacts.js';

export interface ReviewFlags {
    fix: boolean;
    dispatch: boolean;
}

export interface ReviewTargetContext {
    configuredProjectDirs: string[];
    fallbackInstruction: string;
    jawHome: string;
    reportPath: string;
    projectKey: string;
}

export function parseReviewFlags(args: string[]): ReviewFlags {
    return {
        fix: args.includes('--fix'),
        dispatch: args.includes('--dispatch'),
    };
}

export function parseReviewFocus(args: string[]): string {
    return args
        .filter(arg => arg !== '--fix' && arg !== '--dispatch')
        .join(' ')
        .trim();
}

function configuredProjectDirsFromSettings(settingsSource: unknown): string[] {
    const s = settingsSource && typeof settingsSource === 'object'
        ? settingsSource as Record<string, unknown>
        : {};
    const dirs = Array.isArray(s["projectDirs"]) ? s["projectDirs"] : [];
    return dirs
        .filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0)
        .map(dir => dir.trim());
}

function formatConfiguredProjectDirs(dirs: string[]): string {
    return dirs.length ? dirs.join('\n') : '(none configured)';
}

function reviewReportPath(projectKey: string, artifactId: string, now = new Date()): string {
    const day = now.toISOString().slice(0, 10);
    return path.join(JAW_HOME, 'artifacts', 'workflows', 'review-reports', projectKey, day, `${artifactId}.md`);
}

export function buildReviewTargetContext(settingsOverride?: unknown, artifactId = createWorkflowArtifactId('reviewReport')): ReviewTargetContext {
    const s = settingsOverride ?? settings;
    const configuredProjectDirs = configuredProjectDirsFromSettings(s);
    const projectKey = configuredProjectDirs[0]
        ? projectKeyFromPath(configuredProjectDirs[0])
        : 'review-unresolved';
    return {
        configuredProjectDirs,
        fallbackInstruction: configuredProjectDirs.length
            ? 'Validate the first configured project directory as a git repository before reviewing.'
            : 'No projectDirs are configured. Infer the target repo from recent conversation/context, validate it as a git repository, and block if validation fails.',
        jawHome: JAW_HOME,
        reportPath: reviewReportPath(projectKey, artifactId),
        projectKey,
    };
}

export function buildReviewArtifact(
    flags: ReviewFlags,
    locale = 'ko',
    settingsOverride?: unknown,
    reviewFocus = '',
): WorkflowArtifact {
    const id = createWorkflowArtifactId('reviewReport');
    const target = buildReviewTargetContext(settingsOverride, id);

    const mode = flags.dispatch ? 'subagent' : 'direct';
    const fixLabel = flags.fix ? ' + auto-fix' : '';
    const sourcePrompt = [
        '/review',
        reviewFocus,
        flags.fix ? '--fix' : '',
        flags.dispatch ? '--dispatch' : '',
    ].filter(Boolean).join(' ');

    return {
        id,
        kind: 'reviewReport',
        version: 1,
        title: `Project Review (${mode}${fixLabel})`,
        sourcePrompt,
        summary: `Project-dir code review: mode=${mode}, fix=${flags.fix}`,
        locale,
        createdAt: new Date().toISOString(),
        lifetime: 'ephemeral',
        durable: false,
        authoritative: false,
        storage: createWorkflowStorage(target.projectKey),
        sections: [
            { id: 'review-target', title: 'Review target', body: target.configuredProjectDirs[0] || 'Infer from recent context, then validate git repo', format: 'plain', required: true },
            { id: 'configured-project-dirs', title: 'Configured project dirs', body: formatConfiguredProjectDirs(target.configuredProjectDirs), format: 'plain', required: true },
            { id: 'target-policy', title: 'Target resolution policy', body: target.fallbackInstruction, format: 'plain', required: true },
            { id: 'markdown-report', title: 'Markdown report path', body: target.reportPath, format: 'plain', required: true },
            { id: 'review-focus', title: 'Review focus', body: reviewFocus || '(none provided)', format: 'plain', required: false },
            { id: 'mode', title: 'Mode', body: mode, format: 'plain', required: true },
            { id: 'fix', title: 'Auto-fix', body: flags.fix ? 'enabled' : 'disabled', format: 'plain', required: true },
        ],
        suggestedNextActions: [
            { id: 'copy', labelKey: 'cmd.artifact.action.copy', kind: 'copy' },
        ],
    };
}

export function buildReviewSteerPrompt(flags: ReviewFlags, target: ReviewTargetContext, reviewFocus = ''): string {
    const lines = [
        `[System] User invoked /review. Perform a one-shot project-dir code review of recent relevant project changes.`,
        '',
        'Target resolution contract:',
        `- JAW_HOME: ${target.jawHome}`,
        `- Configured projectDirs:\n${formatConfiguredProjectDirs(target.configuredProjectDirs)}`,
        `- Markdown report path: ${target.reportPath}`,
        '- Never use JAW_HOME, ~/.cli-jaw*, settings.workingDir, or process.cwd() as a fallback review target.',
        '- If configured projectDirs are present, choose the first entry and validate it before review.',
        '- If projectDirs are empty, infer the most likely repository from recent conversation/context, then validate it before review.',
        '- Validation requires: absolute path, path exists, `git rev-parse --show-toplevel` succeeds, and the resolved git root is not JAW_HOME.',
        '- If no valid git project target can be resolved, output `BLOCKED: project directory required` with `cli-jaw project set /absolute/path/to/repo`, save that blocked report to the Markdown path, and stop.',
        `- User-requested review focus: ${reviewFocus || '(none provided)'}`,
        '- If a user-requested review focus is provided, treat it as the highest-priority scope signal and use conversation/goal/git evidence to resolve that focused scope before considering broader recent work.',
        '',
        'Steps:',
        '1. Resolve and validate the project repo using the contract above. Treat the validated git top-level as the only Project root.',
        '2. Resolve the review scope from recent work context before reviewing code:',
        '   - Read the current conversation focus first, then recent goal/context signals such as `cli-jaw goal status`, `cli-jaw goal history`, and relevant `cli-jaw chat search ... --recent N` or `--days N` results when available.',
        '   - Inspect git signals such as `git status --short --ignore-submodules=none`, `git log --oneline --decorate --max-count=20`, `git reflog --date=iso --max-count=20`, upstream/merge-base ranges when useful, `git diff --stat HEAD`, `git diff HEAD`, and `git ls-files --others --exclude-standard`.',
        '   - Use git history/diffs as evidence for the conversation-selected work item; do not include unrelated commits merely because they are in `origin/master..HEAD`, a merge-base range, or the recent reflog.',
        '   - Select the important recent project changes to review from committed changes, uncommitted changes, and untracked files. Do not limit the review to `git diff HEAD` when recent context indicates relevant committed work.',
        '   - If no relevant committed changes, uncommitted changes, or untracked files can be identified after scope resolution, report "No project changes to review." and still save the Markdown report.',
        '3. Read the dev-code-reviewer skill (`cat` the SKILL.md from skills/jaw-dev-code-reviewer/).',
        '4. Run pre-scan: `npx tsc --noEmit` (if TypeScript project). Note any errors.',
        '5. Review the selected scope following the skill methodology in order:',
        '   - Architecture: right layer, right abstraction?',
        '   - Correctness: logic errors, edge cases, null handling, error paths',
        '   - Security: input validation, injection risks, secrets exposure',
        '   - Performance: N+1, unbounded collections, missing indexes',
        '   - Maintainability: naming, structure, complexity',
        '6. Output a structured review report with findings grouped by severity:',
        '   - Include a `Scope Resolution` section that lists the chosen base/range or context-derived commit set, included worktree/untracked changes, and why that scope is the right review target.',
        '   - Each finding: `file:line` | Severity (Critical/High/Medium/Low) | Description | Suggested fix',
        '7. Save the final human-readable report as Markdown at the exact Markdown report path above. Create parent directories if needed.',
        '8. End with a verdict: Approve / Approve with suggestions / Request changes / Block',
    ];

    if (flags.fix) {
        lines.push(
            '',
            'AUTO-FIX MODE:',
            '9. After the initial review report, auto-fix all Critical and High severity findings only.',
            '10. Apply fixes only inside the validated Project root as a new working-tree patch on top of current HEAD. Do not rewrite, amend, rebase, or reset existing commits.',
            '11. For each fix: edit the file, verify it compiles, report what changed.',
            '12. Re-run `npx tsc --noEmit` after all fixes to confirm no regressions.',
            '13. Update the Markdown report with the fix summary and verification result.',
        );
    }

    if (flags.dispatch) {
        lines.push(
            '',
            'DISPATCH MODE:',
            'Delegate this entire review to a CLI subagent (Agent tool). Do NOT do the review yourself.',
            'Pass the full target resolution contract and instructions above to the subagent. Synthesize and relay its findings.',
        );
    }

    return lines.join('\n');
}

export function formatReviewText(artifact: WorkflowArtifact): string {
    const lines = [
        artifact.title,
        '',
        ...artifact.sections.flatMap(section => [
            `## ${section.title}`,
            section.body,
            '',
        ]),
        'Review will start automatically.',
    ];
    return lines.join('\n').trim();
}
