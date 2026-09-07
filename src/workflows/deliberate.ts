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

export function buildDeliberateArtifact(
    args: string[],
    locale = 'ko',
    settings?: unknown,
): WorkflowArtifact {
    const request = args.join(' ').trim();
    const sourcePrompt = `/deliberate${request ? ` ${request}` : ''}`;
    const projectKey = projectKeyFromSettings(settings);

    const inputBody = request || tr(
        'cmd.workflow.deliberate.noInput',
        locale,
        'No input was provided. Describe the plan or problem you want to compare approaches for.',
    );

    const roleInstructions = [
        'Planner: propose the implementation approach and estimated scope.',
        'Architect: check integration fit with the current codebase and dependencies.',
        'Critic: identify risks, missing tests, performance concerns, and alternatives.',
        '',
        'End with ONE recommended option and the pre-code checks needed before implementation.',
    ].join('\n');

    return {
        id: createWorkflowArtifactId('deliberationPlan'),
        kind: 'deliberationPlan',
        version: 1,
        title: tr('cmd.workflow.deliberate.title', locale, 'Role-based plan review'),
        sourcePrompt,
        summary: roleInstructions,
        locale,
        createdAt: new Date().toISOString(),
        lifetime: 'local-cache',
        durable: false,
        authoritative: false,
        storage: createWorkflowStorage(projectKey),
        sections: [
            { id: 'input', title: tr('cmd.workflow.deliberate.section.input', locale, 'Input'), body: inputBody, format: 'plain', required: true },
            { id: 'roles', title: tr('cmd.workflow.deliberate.section.roles', locale, 'Role instructions'), body: roleInstructions, format: 'plain', required: true },
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
                'Do not dispatch employees.',
                'Do not write project files or working logs at runtime. Promotion must follow project policy for record placement, including external private records when required.',
                'Do not mark anything PASS/FAIL.',
                'End with one recommendation or an explicit blocker.',
            ],
        },
    };
}

export function formatDeliberateText(artifact: WorkflowArtifact, locale = 'ko'): string {
    const lines = [
        artifact.title,
        '',
        ...artifact.sections.flatMap(section => [
            `## ${section.title}`,
            section.body,
            '',
        ]),
        tr('cmd.workflow.deliberate.footer', locale, 'This is a decision frame only. The approved plan belongs to PABCD P.'),
    ];
    return lines.join('\n').trim();
}
