import {
    sanitizeToolLogEntry,
    sanitizeToolLogForDurableStorage,
    type SanitizableToolLogEntry,
    type SanitizedToolLogEntry,
} from '../shared/tool-log-sanitize.js';

export type LiveRunEntry = {
    running: boolean;
    cli?: string;
    text: string;
    toolLog: SanitizedToolLogEntry[];
    startedAt?: number;
    /** Trace run id of the spawn that owns this live run. Rides on
     *  agent_output/agent_done broadcasts and the orchestrate snapshot so the
     *  web UI can scope SSE replays to the run they belong to (devlog 260612
     *  manager_stream_hidden_state_audit 06-08). */
    traceRunId?: string;
    /** Cumulative streamed length, UNCAPPED — the replay-cursor unit. `text`
     *  keeps only the newest MAX_LIVE_TEXT_CHARS tail (260613 05 finding 9),
     *  so cursor math must never use `text.length` once the cap engages. */
    textLen?: number;
};

/** Within-run spike cap for the hydration text. A 50MB-output run used to
 *  hold 50MB here until clearLiveRun; the UI only ever renders the tail. */
const MAX_LIVE_TEXT_CHARS = 200_000;

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
        textLen: 0,
        toolLog: [],
        startedAt: Date.now(),
    });
}

/** Append a streamed segment. Returns the cumulative text length after the
 *  append (the replay-dedup cursor broadcast as `textLen`), or null when no
 *  live run is active for the scope. */
export function appendLiveRunText(scope: string, text: string): number | null {
    const current = liveRuns.get(scope);
    if (!current?.running) return null;
    current.textLen = (current.textLen ?? current.text.length) + (text ? text.length : 0);
    if (text) {
        current.text += text;
        if (current.text.length > MAX_LIVE_TEXT_CHARS) {
            current.text = current.text.slice(-MAX_LIVE_TEXT_CHARS);
        }
    }
    return current.textLen;
}

/** Bind the trace run id once startTraceRun has produced it (beginLiveRun
 *  runs earlier in every spawn path, so the id arrives via this setter). */
export function setLiveRunTraceId(scope: string, traceRunId: string): void {
    const current = liveRuns.get(scope);
    if (!current?.running || !traceRunId) return;
    current.traceRunId = traceRunId;
}

export function replaceLiveRunTools(scope: string, toolLog: unknown[]): void {
    const current = liveRuns.get(scope);
    if (!current?.running) return;
    const sanitized = sanitizeToolLogForDurableStorage(toolLog);
    toolLog.splice(0, toolLog.length, ...sanitized);
    // Preserve worker-mirror entries (isEmployee) already accumulated in this scope:
    // a boss tool sync must NOT wipe employee progress appended via appendLiveRunTool.
    // Without this, a dense boss (claude) overwrites the scope on every tool, so the
    // mirrors are gone by persist time, while a sparse boss (codex) leaves them intact
    // — the exact reported tool-card asymmetry (hydration loss R1, devlog 260620).
    const mirrors = current.toolLog.filter((t) => t.isEmployee === true);
    current.toolLog = mirrors.length
        ? sanitizeToolLogForDurableStorage([...sanitized, ...mirrors])
        : sanitized;
}

export function appendLiveRunTool(scope: string, tool: SanitizableToolLogEntry): void {
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
