import { t } from '../core/i18n.js';
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

function formatRequest(args: string[]): string {
    return args.join(' ').trim();
}

export function buildPlanCompatArtifact(
    args: string[],
    locale = 'ko',
    settings?: unknown,
): WorkflowArtifact {
    const request = formatRequest(args);
    const sourcePrompt = `/plan${request ? ` ${request}` : ''}`;
    const projectKey = projectKeyFromSettings(settings);
    const pabcdText = tr(
        'cmd.workflow.plan.pabcdEquivalent',
        locale,
        'In cli-jaw, /plan maps to PABCD P: clarify the plan first, then audit, build, check, and close.',
    );
    const sourceText = request || tr(
        'cmd.workflow.plan.noRequest',
        locale,
        'No request was provided. Use /interview for unclear requirements or /deliberate for comparing implementation options.',
    );
    const nextText = [
        tr('cmd.workflow.plan.next.interview', locale, '- Need clearer requirements: /interview <request>'),
        tr('cmd.workflow.plan.next.deliberate', locale, '- Need option comparison: /deliberate <request-or-plan>'),
        tr('cmd.workflow.plan.next.planaudit', locale, '- Already have a plan: /planaudit <plan>'),
        tr('cmd.workflow.plan.next.orchestrate', locale, '- Ready to formalize: /orchestrate P'),
    ].join('\n');

    return {
        id: createWorkflowArtifactId('planCompat'),
        kind: 'planCompat',
        version: 1,
        title: tr('cmd.workflow.plan.title', locale, 'PABCD planning guide'),
        sourcePrompt,
        summary: pabcdText,
        locale,
        createdAt: new Date().toISOString(),
        lifetime: 'local-cache',
        durable: false,
        authoritative: false,
        storage: createWorkflowStorage(projectKey),
        sections: [
            { id: 'pabcd-equivalent', title: tr('cmd.workflow.plan.section.pabcd', locale, 'cli-jaw planning'), body: pabcdText, format: 'plain', required: true },
            { id: 'source-request', title: tr('cmd.workflow.plan.section.source', locale, 'Original request'), body: sourceText, format: 'plain', required: true },
            { id: 'next-actions', title: tr('cmd.workflow.plan.section.next', locale, 'Next actions'), body: nextText, format: 'plain', required: true },
        ],
        suggestedNextActions: [
            { id: 'copy', labelKey: 'cmd.artifact.action.copy', kind: 'copy' },
            { id: 'reinsert', labelKey: 'cmd.artifact.action.reinsert', kind: 'reinsert' },
            { id: 'start-pabcd', labelKey: 'cmd.artifact.action.startPabcd', kind: 'start-pabcd', requiresConfirmation: true },
        ],
        promotion: {
            allowedTargets: ['pabcd-worklog', 'devlog', 'project-file'],
            defaultTarget: 'pabcd-worklog',
            requiresUserAction: true,
            guardrails: [
                'Do not create a second plan mode.',
                'Do not enter PABCD without explicit user action.',
                'Do not write project files by default. Promotion must follow project policy for record placement, including external private records when required.',
            ],
        },
    };
}

export function formatPlanCompatText(artifact: WorkflowArtifact, locale = 'ko'): string {
    const lines = [
        artifact.title,
        '',
        ...artifact.sections.flatMap(section => [
            `## ${section.title}`,
            section.body,
            '',
        ]),
        tr('cmd.workflow.plan.footer', locale, 'This is guidance only. The approved plan still belongs to PABCD P.'),
    ];
    return lines.join('\n').trim();
}
