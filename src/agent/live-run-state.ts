import { sanitizeToolLogEntry, sanitizeToolLogForDurableStorage } from '../shared/tool-log-sanitize.js';

export type LiveRunEntry = {
    running: boolean;
    cli?: string;
    text: string;
    toolLog: any[];
    startedAt?: number;
};

const EMPTY_LIVE_RUN: LiveRunEntry = {
    running: false,
    text: '',
    toolLog: [],
};

const liveRuns = new Map<string, LiveRunEntry>();

function cloneEntry(entry: LiveRunEntry): LiveRunEntry {
    return {
        ...entry,
        toolLog: sanitizeToolLogForDurableStorage(entry.toolLog),
    };
}

export function beginLiveRun(scope: string, cli: string): void {
    liveRuns.set(scope, {
        running: true,
        cli,
        text: '',
        toolLog: [],
        startedAt: Date.now(),
    });
}

export function appendLiveRunText(scope: string, text: string): void {
    if (!text) return;
    const current = liveRuns.get(scope);
    if (!current?.running) return;
    current.text += text;
}

export function replaceLiveRunTools(scope: string, toolLog: any[]): void {
    const current = liveRuns.get(scope);
    if (!current?.running) return;
    const sanitized = sanitizeToolLogForDurableStorage(toolLog);
    toolLog.splice(0, toolLog.length, ...sanitized);
    current.toolLog = sanitized;
}

export function appendLiveRunTool(scope: string, tool: any): void {
    const current = liveRuns.get(scope);
    if (!current?.running) return;
    current.toolLog.push(sanitizeToolLogEntry(tool));
    current.toolLog = sanitizeToolLogForDurableStorage(current.toolLog);
}

export function clearLiveRun(scope: string): void {
    liveRuns.delete(scope);
}

export function getLiveRun(scope: string): LiveRunEntry {
    return cloneEntry(liveRuns.get(scope) || EMPTY_LIVE_RUN);
}
