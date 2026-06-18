import {
    sanitizeToolLogForDurableStorage,
    type SanitizedToolLogEntry,
} from '../shared/tool-log-sanitize.js';
import {
    displayShellCommand,
    displayShellCommandDetail,
} from '../shared/shell-command-display.js';

export type WorkerRunState = 'running' | 'done' | 'failed' | 'cancelled';
export type WorkerProgressAttentionKind =
    | 'stalled'
    | 'disconnected'
    | 'timeout'
    | 'pending_replay'
    | 'replay_claimed'
    | 'replay_failed';

export interface WorkerProgressAttention {
    kind: WorkerProgressAttentionKind;
    message: string;
    occurredAt: number;
    exitCode?: number | null;
    attempts?: number;
}

export interface WorkerProgressRun {
    agentId: string;
    employeeName: string;
    state: WorkerRunState;
    taskPreview: string;
    phase?: string | null;
    phaseLabel?: string | null;
    startedAt: number;
    completedAt: number | null;
    progressUpdatedAt: number | null;
    resultPreview?: string;
    attention?: WorkerProgressAttention;
    tools: SanitizedToolLogEntry[];
}

export interface WorkerProgressSnapshot {
    agentId: string;
    employeeName: string;
    current: WorkerProgressRun | null;
    previous: WorkerProgressRun | null;
    generatedAt: number;
}

export function isThinkingEntry(entry: Pick<SanitizedToolLogEntry, 'icon' | 'toolType' | 'label'>): boolean {
    const type = String(entry.toolType || '').toLowerCase();
    const label = String(entry.label || '').toLowerCase();
    return type === 'thinking' || entry.icon === '💭' || label.includes('thinking') || label.includes('reasoning');
}

export function sanitizeWorkerProgressTools(entries: unknown): SanitizedToolLogEntry[] {
    const sanitized = sanitizeToolLogForDurableStorage(entries);
    return sanitized
        .filter((entry) => !isThinkingEntry(entry))
        .map((entry) => {
            const detail = entry.detail
                ? displayShellCommandDetail(entry.detail).replace(/\s+/g, ' ').trim().slice(0, 240)
                : '';
            return {
                ...entry,
                label: displayShellCommand(entry.label),
                ...(detail ? { detail } : {}),
            };
        });
}

export function previewText(value: unknown, max = 200): string | undefined {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
