import type { RuntimeEvent } from './runtime-contract.js';
import { parseRuntimeEvent } from './runtime-event-parse.js';

const PAGE_SIZE = 40;
const PAGE_BYTES = 270_000; // Includes JSON/envelope overhead above the journal's 256 KiB budget.
const RUN_EVENTS = 4096;
const RUN_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 4097;
const DISCOVERY_RUNS = 256;
const encoder = new TextEncoder();
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240;
const cursor = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export type ActivityReader = (path: string, signal: AbortSignal) => Promise<unknown>;
export interface ActivityReadOptions {
    sessionId: string;
    signal: AbortSignal;
    read: ActivityReader;
}
export interface ActivityRunReadResult {
    events: RuntimeEvent[];
    through: number;
    scope: string;
    incomplete: boolean;
    loss: string | null;
}
export interface ActivityRunSummary {
    id: string;
    messageId: number | null;
    status: 'running' | 'done' | 'error' | 'interrupted';
    startedAt: number;
}
export interface ActivityRunsReadResult {
    runs: ActivityRunSummary[];
    /** True when the local discovery bound is reached. False is not a chronological snapshot guarantee. */
    incomplete: boolean;
}

/** The injected reader owns HTTP status, authentication and transport cancellation.
 * Accept the server's ok/data envelope or an already-unwrapped bare payload. An
 * envelope-looking response must validate as an envelope; it cannot fall back.
 */
async function readPage(options: ActivityReadOptions, path: string): Promise<unknown> {
    options.signal.throwIfAborted();
    const raw = await options.read(path, options.signal);
    options.signal.throwIfAborted();
    const serialized = JSON.stringify(raw);
    if (serialized !== undefined && encoder.encode(serialized).length > PAGE_BYTES) throw new Error('activity_page_limit');
    if (!record(raw) || (!Object.hasOwn(raw, 'ok') && !Object.hasOwn(raw, 'data'))) return raw;
    if (raw['ok'] !== true || !record(raw['data'])) throw new Error('invalid_activity_envelope');
    return raw['data'];
}

/** Display-only canonical events, with a fixed high-water cursor across all pages.
 * Invalid pages and local resource limits reject rather than returning partial success.
 */
export async function readActivityRun(options: ActivityReadOptions & { runId: string }): Promise<ActivityRunReadResult> {
    if (!id(options.runId) || !id(options.sessionId)) throw new Error('invalid_activity_identity');
    const events: RuntimeEvent[] = [];
    let after = 0;
    let through: number | undefined;
    let scope: string | undefined;
    let incomplete = false;
    let loss: string | null = null;
    let bytes = 0;
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
        const query = new URLSearchParams({ session: options.sessionId, after: String(after), limit: String(PAGE_SIZE) });
        if (through !== undefined) query.set('through', String(through));
        const page = await readPage(options, `/api/traces/${encodeURIComponent(options.runId)}/activity?${query}`);
        if (!record(page) || page['runId'] !== options.runId || page['sessionId'] !== options.sessionId
            || !id(page['scope']) || !cursor(page['through']) || !cursor(page['nextAfter'])
            || typeof page['hasMore'] !== 'boolean' || typeof page['incomplete'] !== 'boolean'
            || (page['loss'] !== null && typeof page['loss'] !== 'string')
            || !Array.isArray(page['events']) || page['events'].length > PAGE_SIZE) throw new Error('invalid_activity_page');
        if (through !== undefined && page['through'] !== through) throw new Error('activity_cursor_changed');
        if (scope !== undefined && page['scope'] !== scope) throw new Error('activity_scope_changed');
        through = page['through'];
        scope = page['scope'];
        const nextAfter = page['nextAfter'];
        if (nextAfter < after || nextAfter > through) throw new Error('invalid_activity_cursor');
        for (const value of page['events']) {
            const event = parseRuntimeEvent(value);
            if (!event || event.runId !== options.runId || event.sessionId !== options.sessionId
                || event.scope !== scope || event.seq <= after || event.seq > nextAfter) throw new Error('invalid_activity_identity');
            const previous = events[events.length - 1];
            if (previous && event.seq <= previous.seq) throw new Error('unordered_activity_page');
            bytes += encoder.encode(JSON.stringify(event)).length;
            if (events.length >= RUN_EVENTS || bytes > RUN_BYTES) throw new Error('activity_run_limit');
            events.push(event);
        }
        incomplete ||= page['incomplete'] || page['loss'] !== null;
        loss ??= page['loss']; // Keep the first loss even if subsequent pages look healthy.
        if (!page['hasMore']) return { events, through, scope, incomplete, loss };
        // Corrupt rows can advance without returning events. Terminal empty pages may stall.
        if (nextAfter <= after) throw new Error('activity_cursor_stalled');
        after = nextAfter;
    }
    throw new Error('activity_page_count_limit');
}

function parseRun(value: unknown, sessionId: string): ActivityRunSummary {
    if (!record(value) || !id(value['id']) || !cursor(value['startedAt'])
        || (value['messageId'] !== null && (!cursor(value['messageId']) || value['messageId'] === 0))
        || (Object.hasOwn(value, 'sessionId') && value['sessionId'] !== sessionId)) throw new Error('invalid_activity_run');
    const status = value['status'];
    if (status !== 'running' && status !== 'done' && status !== 'error' && status !== 'interrupted') throw new Error('invalid_activity_run');
    return { id: value['id'], messageId: value['messageId'], status, startedAt: value['startedAt'] };
}

/** ID-keyset discovery, not chronological history. Concurrent IDs before the cursor
 * require SSE or a later discovery pass. The server owns session authorization.
 */
export async function readActivityRuns(options: ActivityReadOptions): Promise<ActivityRunsReadResult> {
    if (!id(options.sessionId)) throw new Error('invalid_activity_identity');
    const runs: ActivityRunSummary[] = [];
    let after = '';
    while (runs.length < DISCOVERY_RUNS) {
        const query = new URLSearchParams({ session: options.sessionId, after });
        const page = await readPage(options, `/api/traces/activity-runs?${query}`);
        if (!record(page) || page['pageSize'] !== PAGE_SIZE || !Array.isArray(page['runs'])
            || page['runs'].length > PAGE_SIZE
            || (Object.hasOwn(page, 'sessionId') && page['sessionId'] !== options.sessionId)) throw new Error('invalid_activity_runs_page');
        // Validate the whole page, including rows beyond the remaining retention budget.
        const rows = page['runs'].map(value => parseRun(value, options.sessionId));
        for (const row of rows) {
            if (row.id <= after) throw new Error('activity_runs_cursor_stalled');
            after = row.id; // Opaque ID in server ascending order; never a timestamp or offset.
        }
        runs.push(...rows.slice(0, DISCOVERY_RUNS - runs.length));
        if (runs.length >= DISCOVERY_RUNS) return { runs, incomplete: true };
        if (rows.length < PAGE_SIZE) return { runs, incomplete: false };
    }
    return { runs, incomplete: true };
}
