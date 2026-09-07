import { t } from '../core/i18n.js';
import { settings } from '../core/config.js';
import type { WorkflowArtifact } from '../cli/types.js';
import {
    createWorkflowArtifactId,
    createWorkflowStorage,
    projectKeyFromSettings,
} from './artifacts.js';

function tr(key: string, locale: string, fallback: string): string {
    const value = t(key, {}, locale);
    return value === key ? fallback : value;
}

export function buildPlanAuditArtifact(
    args: string[],
    locale = 'ko',
    settingsOverride?: unknown,
): WorkflowArtifact {
    const plan = args.join(' ').trim();
    const sourcePrompt = `/planaudit${plan ? ` ${plan}` : ''}`;
    const s = settingsOverride ?? settings;
    const projectKey = projectKeyFromSettings(s);
    const workingDir = (s && typeof s === 'object' ? (s as Record<string, unknown>)['workingDir'] : null) as string | null;
    const projectRoot = workingDir || '<absolute project root>';

    const planBody = plan || tr(
        'cmd.workflow.planaudit.noPlan',
        locale,
        '<current PABCD plan>',
    );

    const checks = [
        'Verify all file paths in the plan actually exist.',
        'Verify imports and function signatures match real code.',
        'Check for integration risks.',
        'Verify existing source-of-truth docs/logs were read when present.',
        'No new structure/, working logs, docs, or AGENTS files without user approval. Follow project policy for record placement; keep private records external when required.',
        'New TS files follow strict-compatible TypeScript.',
        'Plan phase documents use the numbered lexicographic filename convention (LEXICO-SPLIT-01); bare-named or research/implementation-mixed docs are a FAIL.',
        'Multi-phase units satisfy DIFFLEVEL-ROADMAP-01: every roadmap phase has a diff-level decade doc, and the phase map is dependency-ordered (PHASE-SPLIT-01).',
    ].join('\n- ');

    return {
        id: createWorkflowArtifactId('auditTask'),
        kind: 'auditTask',
        version: 1,
        title: tr('cmd.workflow.planaudit.title', locale, 'Read-only plan audit'),
        sourcePrompt,
        summary: `Audit task for: ${planBody.slice(0, 100)}`,
        locale,
        createdAt: new Date().toISOString(),
        lifetime: 'local-cache',
        durable: false,
        authoritative: false,
        storage: createWorkflowStorage(projectKey),
        sections: [
            { id: 'project-root', title: 'Project root', body: projectRoot, format: 'plain', required: true },
            { id: 'plan', title: 'Plan', body: planBody, format: 'plain', required: true },
            { id: 'checks', title: 'Read-only checks', body: `- ${checks}`, format: 'plain', required: true },
            { id: 'authority', title: 'Authority boundaries', body: 'Read-only audit only. Do not implement code, write files, or dispatch employees.', format: 'plain', required: true },
            { id: 'verdict', title: 'Required verdict', body: 'PASS or FAIL with specific findings.', format: 'plain', required: true },
        ],
        suggestedNextActions: [
            { id: 'copy', labelKey: 'cmd.artifact.action.copy', kind: 'copy' },
            { id: 'reinsert', labelKey: 'cmd.artifact.action.reinsert', kind: 'reinsert' },
        ],
    };
}

export function formatPlanAuditText(artifact: WorkflowArtifact, locale = 'ko'): string {
    const lines = [
        artifact.title,
        '',
        ...artifact.sections.flatMap(section => [
            `## ${section.title}`,
            section.body,
            '',
        ]),
        tr('cmd.workflow.planaudit.footer', locale, 'Preview only. Dispatch is handled by PABCD A phase.'),
    ];
    return lines.join('\n').trim();
}
