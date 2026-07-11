import {
    parseToolLogBounded,
    sanitizeToolLogForDurableStorage,
    serializeSanitizedToolLog,
} from '../../../../../src/shared/tool-log-sanitize.js';
import {
    displayShellCommand,
    displayShellCommandDetail,
} from '../../../../../src/shared/shell-command-display.js';
import type { MessageItem, ToolLogEntry } from '../../../../../src/shared/chat-events.js';
import type { ProcessStep } from './process-step-match.js';

function generateId(): string {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
    if (typeof cryptoApi?.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        cryptoApi.getRandomValues(bytes);
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
        const random = (Math.random() * 16) | 0;
        return (ch === 'x' ? random : (random & 0x3) | 0x8).toString(16);
    });
}

function processStepType(toolType?: string): ProcessStep['type'] {
    return toolType === 'thinking' || toolType === 'search' || toolType === 'subagent'
        ? toolType
        : 'tool';
}

function processStepStatus(status?: string): ProcessStep['status'] {
    return status === 'running' || status === 'done' || status === 'error' ? status : 'done';
}

function fallbackToolLabel(tool: ToolLogEntry): string {
    if (tool.label) return tool.label;
    const named = tool as ToolLogEntry & { name?: unknown };
    return typeof named.name === 'string' && named.name ? named.name : 'tool';
}

function displayToolLabel(tool: ToolLogEntry): string {
    const label = fallbackToolLabel(tool);
    return tool.toolType === 'tool' ? displayShellCommand(label) : label;
}

function resolvePureIcon(icon: string): string {
    const normalized = icon.trim();
    return normalized.startsWith('<svg') ? normalized : normalized;
}

export function parseToolLog(toolLog?: string | null): ToolLogEntry[] {
    return parseToolLogBounded(toolLog) as ToolLogEntry[];
}

export function sanitizedToolLogJson(toolLog?: string | null): string | null {
    return serializeSanitizedToolLog(parseToolLog(toolLog));
}

export function normalizeMessageToolLog<T extends MessageItem>(message: T): T {
    if (message.role !== 'assistant' || !message.tool_log) return { ...message, tool_log: null };
    return { ...message, tool_log: sanitizedToolLogJson(message.tool_log) };
}

export function toProcessSteps(tools: ToolLogEntry[], runStartedAt?: number): ProcessStep[] {
    const baseTime = runStartedAt && runStartedAt > 0 ? runStartedAt : Date.now();
    return tools.map((tool) => ({
        id: generateId(),
        icon: resolvePureIcon(tool.icon),
        rawIcon: tool.rawIcon || tool.icon || '',
        label: displayToolLabel(tool),
        isEmployee: tool.isEmployee === true,
        type: processStepType(tool.toolType),
        detail: tool.toolType === 'tool' ? displayShellCommandDetail(tool.detail || '') : tool.detail || '',
        stepRef: tool.stepRef || '',
        traceRunId: tool.traceRunId || '',
        traceSeq: tool.traceSeq,
        detailAvailable: tool.detailAvailable,
        detailBytes: tool.detailBytes,
        rawRetentionStatus: tool.rawRetentionStatus,
        status: processStepStatus(tool.status),
        startTime: baseTime,
    }));
}

function identityKey(entry: ToolLogEntry, ordinal: number): string {
    const stepRef = String(entry.stepRef || '').trim();
    if (stepRef) return `ref:${stepRef}`;
    return `ord:${entry.toolType || 'tool'}:${entry.label || 'tool'}:${ordinal}`;
}

export function mergeExplicitAndLiveToolLogs(explicit: ToolLogEntry[], live: ToolLogEntry[]): ToolLogEntry[] {
    if (explicit.length === 0) return live;
    const merged = new Map<string, ToolLogEntry>();
    const ordinalCounts = new Map<string, number>();
    const keyFor = (entry: ToolLogEntry): string => {
        const base = `${entry.toolType || 'tool'}:${entry.label || 'tool'}`;
        const next = (ordinalCounts.get(base) || 0) + 1;
        ordinalCounts.set(base, next);
        return identityKey(entry, next);
    };
    live.forEach(entry => merged.set(keyFor(entry), entry));
    ordinalCounts.clear();
    explicit.forEach(entry => {
        const key = keyFor(entry);
        const liveEntry = merged.get(key);
        const liveDetail = liveEntry?.detail || '';
        const explicitDetail = entry.detail || '';
        merged.set(key, {
            ...(liveEntry || {}),
            ...entry,
            detail: explicitDetail.length >= liveDetail.length ? explicitDetail : liveDetail,
            status: entry.status || liveEntry?.status || 'done',
        });
    });
    return Array.from(merged.values());
}

export function sanitizedToolLogEntries(entries: ToolLogEntry[]): ToolLogEntry[] {
    return sanitizeToolLogForDurableStorage(entries) as ToolLogEntry[];
}

export function sanitizedToolLogJsonFromEntries(entries: ToolLogEntry[]): string | null {
    return serializeSanitizedToolLog(entries);
}
