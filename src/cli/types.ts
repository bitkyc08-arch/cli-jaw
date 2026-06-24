// ─── Shared types for src/cli/ slash-command surface ─────────
// Internal to src/cli/. Do NOT import from src/agent/, src/routes/, or bin/.

import type { CliCommandContext } from './command-context.js';

export type SlashIface = 'cli' | 'web' | 'telegram' | 'discord';

export interface SlashResult {
    ok?: boolean;
    type?: string;
    code?: string;
    steerPrompt?: string;
    text?: string;
    originalText?: string;
    recovery?: UnknownCommandRecovery;
    artifact?: WorkflowArtifact;
    [k: string]: unknown;
}

export type SlashHandler = (
    args: string[],
    ctx: CliCommandContext,
) => Promise<SlashResult> | SlashResult;

export type WorkflowCommandPhase =
    | 'requirements'
    | 'planning'
    | 'audit'
    | 'execution'
    | 'quality'
    | 'continuation';

export type WorkflowCommandRisk = 'low' | 'medium' | 'high';

export type WorkflowCommandOutput =
    | 'prompt'
    | 'plan'
    | 'dispatch'
    | 'state'
    | 'report';

export type WorkflowArgumentKind =
    | 'text'
    | 'repo-path'
    | 'agent'
    | 'mode';

export interface WorkflowCommandArg {
    name: string;
    required: boolean;
    kind: WorkflowArgumentKind;
}

export interface WorkflowCommandMeta {
    kind: 'workflow';
    phase: WorkflowCommandPhase;
    risk: WorkflowCommandRisk;
    output: WorkflowCommandOutput;
    workflowArgs?: readonly WorkflowCommandArg[];
}

export type WorkflowArtifactKind =
    | 'planCompat'
    | 'unknownCommandRecovery'
    | 'interviewBrief'
    | 'deliberationPlan'
    | 'auditTask'
    | 'reviewReport';

export type WorkflowArtifactLifetime =
    | 'ephemeral'
    | 'session'
    | 'local-cache'
    | 'pabcd-worklog'
    | 'memory'
    | 'devlog'
    | 'project-file';

export type WorkflowArtifactFormat = 'plain' | 'markdown';

export interface WorkflowArtifactSection {
    id: string;
    title: string;
    body: string;
    format: WorkflowArtifactFormat;
    required?: boolean;
}

export interface WorkflowArtifactAction {
    id: string;
    labelKey: string;
    kind:
        | 'copy'
        | 'reinsert'
        | 'send-as-chat'
        | 'start-pabcd'
        | 'save-jawdev'
        | 'export-project-file'
        | 'preview-audit';
    requiresConfirmation?: boolean;
}

export interface WorkflowArtifactStorage {
    mode: 'chat' | 'jaw-home-cache' | 'pabcd-worklog' | 'jawdev-devlog' | 'memory' | 'project-file';
    path?: string;
    projectKey?: string;
    retentionDays?: number;
    writeStatus?: 'saved' | 'failed';
    writeError?: string;
}

export interface WorkflowArtifactPromotion {
    allowedTargets: WorkflowArtifactLifetime[];
    defaultTarget: WorkflowArtifactLifetime;
    requiresUserAction: true;
    guardrails: string[];
}

export interface WorkflowArtifact {
    id: string;
    kind: WorkflowArtifactKind;
    version: 1;
    title: string;
    sourcePrompt: string;
    summary?: string;
    locale?: string;
    createdAt?: string;
    lifetime: WorkflowArtifactLifetime;
    durable: boolean;
    authoritative: boolean;
    storage: WorkflowArtifactStorage;
    sections: WorkflowArtifactSection[];
    suggestedNextActions: WorkflowArtifactAction[];
    promotion?: WorkflowArtifactPromotion;
}

export interface UnknownCommandRecovery {
    kind: 'slash-command-original';
    commandName: string;
    args: string[];
    originalText: string;
    suggestedCommands: string[];
}

export interface SlashChoice {
    value: string;
    label?: string;
    desc?: string;
    name?: string;
}

export type SlashArgumentCompleter = (
    ctx: CompletionCtx,
    argv?: string[],
    partial?: string,
) => SlashChoice[] | Promise<SlashChoice[]>;

// Lightweight context passed to argument-completion functions. Distinct from
// CliCommandContext: completions can be invoked without a full command runtime
// (e.g., from autocomplete preview), so the shape is a permissive subset.
export interface CompletionCtx {
    locale?: string;
    settings?: {
        cli?: string;
        perCli?: Record<string, unknown>;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}

export interface SlashCommand {
    name: string;
    aliases?: readonly string[];
    descKey?: string;
    tgDescKey?: string;
    desc?: string;
    args?: string;
    category?: string;
    interfaces: readonly string[];
    hidden?: boolean;
    workflow?: WorkflowCommandMeta;
    helpDetailKey?: string;
    handler: SlashHandler | ((...args: unknown[]) => unknown);
    getArgumentCompletions?: SlashArgumentCompleter;
}

export type ParsedSlashCommand =
    | { type: 'known'; cmd: SlashCommand; args: string[]; name: string; rawText?: string }
    | { type: 'skill'; skillId: string; name: string; args: string[]; rawText?: string }
    | { type: 'unknown'; name: string; args: string[]; rawText?: string }
    | null;

// Overlay item shape used by autocomplete + palette overlays in src/cli/tui/.
// bin/commands/tui/overlays.ts may pass a richer shape; reconcile in P10b.
export interface OverlayItem {
    name: string;
    desc?: string;
    args?: string;
    category?: string;
    command?: string;
    commandDesc?: string;
    insertText?: string;
    kind?: string;
    [k: string]: unknown;
}
