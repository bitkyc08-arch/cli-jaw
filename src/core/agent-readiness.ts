/**
 * Agent-runtime readiness for the configured CLI (#471).
 *
 * `/api/health` answers LIVENESS: its `ok` has been a constant since the
 * endpoint was added for Docker HEALTHCHECK, and Docker restarts the container
 * and the manager drops the instance when it turns false. So a server whose
 * configured CLI could not be resolved still reported healthy for 16 hours
 * while every prompt failed before spawn. This module answers the OTHER
 * question — can the configured agent actually be launched — and leaves the
 * liveness contract alone.
 *
 * Why a cache: `detectCli` shells out to `where.exe`/`which` with a 3s
 * timeout, synchronously. `/api/health` is a polling route, so calling it
 * inline would block the event loop on every poll. Reads are served from the
 * last result and refreshes run off the request path, the same shape
 * `CliStatusCache` uses for the full multi-CLI probe.
 */
import { detectCli, settings } from './config.js';
import { formatCliUnavailableMessage } from './cli-detect.js';

export type AgentReadinessState = 'ready' | 'unavailable' | 'unknown';

export interface AgentReadinessSnapshot {
    /** Configured CLI, or null when none is set. */
    cli: string | null;
    ready: boolean;
    state: AgentReadinessState;
    /** Resolved binary path when ready. */
    path?: string;
    /** User-facing reason when not ready. */
    error?: string;
    /** Epoch ms of the probe this snapshot came from; null before the first. */
    checkedAt: number | null;
}

export interface AgentReadinessOptions {
    now?: () => number;
    ttlMs?: number;
    /** Injected probe. Returns the snapshot fields a detection can determine. */
    probe?: (cli: string) => { ready: boolean; path?: string; error?: string };
}

const TTL_MS = 15_000;

function defaultProbe(cli: string): { ready: boolean; path?: string; error?: string } {
    const detected = detectCli(cli);
    if (detected.available) {
        return detected.path ? { ready: true, path: detected.path } : { ready: true };
    }
    return { ready: false, error: formatCliUnavailableMessage(cli, detected) };
}

/**
 * Readiness of one CLI, refreshed off the request path.
 *
 * Deliberately NOT reusing CliStatusCache: that one forks a worker to probe
 * every registered CLI plus auth and capability. Readiness needs one binary
 * lookup for the configured CLI, and putting a fork on the health path would
 * trade a blocked event loop for a process spawn per poll.
 */
export class AgentReadinessCache {
    private readonly now: () => number;
    private readonly ttlMs: number;
    private readonly probe: (cli: string) => { ready: boolean; path?: string; error?: string };
    private last: AgentReadinessSnapshot | null = null;
    private lastCli: string | null = null;
    private refreshingCli: string | null = null;

    constructor(options: AgentReadinessOptions = {}) {
        this.now = options.now ?? Date.now;
        this.ttlMs = options.ttlMs ?? TTL_MS;
        this.probe = options.probe ?? defaultProbe;
    }

    /** Never blocks. Returns the last known snapshot and schedules a refresh when stale. */
    getSnapshot(): AgentReadinessSnapshot {
        const cli = (settings['cli'] as string | undefined) || null;
        if (!cli) {
            // No configured CLI is a configuration state, not a broken runtime.
            // Reporting it as `unavailable` would make a fresh install look
            // failed; `unknown` keeps liveness and readiness both honest.
            return { cli: null, ready: false, state: 'unknown', checkedAt: null };
        }

        // A CLI switch invalidates immediately: serving the previous CLI's
        // verdict under the new name would be a wrong answer, not a stale one.
        if (this.lastCli !== cli) {
            this.last = null;
            this.lastCli = cli;
        }

        const age = this.last?.checkedAt == null
            ? Number.POSITIVE_INFINITY
            : this.now() - this.last.checkedAt;
        if (age > this.ttlMs) this.scheduleRefresh(cli);

        return this.last ?? { cli, ready: false, state: 'unknown', checkedAt: null };
    }

    /** Probe now and wait for the result. For CLI/doctor paths, never for polling routes. */
    async refreshNow(): Promise<AgentReadinessSnapshot> {
        const cli = (settings['cli'] as string | undefined) || null;
        if (!cli) return { cli: null, ready: false, state: 'unknown', checkedAt: null };
        this.lastCli = cli;
        this.runProbe(cli);
        return this.last ?? { cli, ready: false, state: 'unknown', checkedAt: null };
    }

    private scheduleRefresh(cli: string): void {
        // Keyed by CLI, not a bare boolean. A bare flag set by a probe for the
        // PREVIOUS cli stays true across a switch and every later refresh is
        // skipped, freezing the cache on 'unknown' for good. Found by AR-005,
        // and live-reachable: settings.cli is editable at runtime via
        // PUT /api/settings.
        if (this.refreshingCli === cli) return;
        this.refreshingCli = cli;
        // setImmediate, not await: the caller is a request handler and must not
        // wait on a synchronous 3s-timeout lookup.
        setImmediate(() => {
            try { this.runProbe(cli); } finally {
                if (this.refreshingCli === cli) this.refreshingCli = null;
            }
        });
    }

    private runProbe(cli: string): void {
        try {
            const result = this.probe(cli);
            this.last = {
                cli,
                ready: result.ready,
                state: result.ready ? 'ready' : 'unavailable',
                ...(result.path ? { path: result.path } : {}),
                ...(result.error ? { error: result.error } : {}),
                checkedAt: this.now(),
            };
        } catch (error) {
            // A probe that throws is not evidence the CLI is missing, so this
            // must not read as `unavailable` — that would let a probe bug
            // trigger an operator's restart policy.
            this.last = {
                cli,
                ready: false,
                state: 'unknown',
                error: error instanceof Error ? error.message : String(error),
                checkedAt: this.now(),
            };
        }
    }
}

const defaultCache = new AgentReadinessCache();

export function getAgentReadiness(): AgentReadinessSnapshot {
    return defaultCache.getSnapshot();
}

export function refreshAgentReadiness(): Promise<AgentReadinessSnapshot> {
    return defaultCache.refreshNow();
}

/** @internal exported for deterministic tests. */
export function createAgentReadinessCacheForTest(options: AgentReadinessOptions): AgentReadinessCache {
    return new AgentReadinessCache(options);
}
