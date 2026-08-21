// Independent CDP liveness probe.
//
// Ported from agbrowse `web-ai/cdp-liveness.mjs` (parity2 020 slice 2.2,
// catalog B6). After a Playwright/CDP client disconnect, probe Chrome's HTTP
// DevTools endpoint OUT-OF-BAND to classify the disconnect: Chrome alive with
// the target present means the disconnect is recoverable by reattaching;
// anything else is fatal for that tab.

export interface CdpLiveness {
    endpointReachable: boolean;
    targetFound: boolean | null;
    matchedUrl?: string;
    error?: string;
}

export interface ProbeCdpLivenessOptions {
    port: number;
    targetId?: string | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

/** Probe Chrome independently from the CDP client that disconnected. */
export async function probeCdpLiveness(options: ProbeCdpLivenessOptions): Promise<CdpLiveness> {
    const port = Number(options.port);
    const targetId = options.targetId?.trim() || '';
    if (!Number.isFinite(port) || port <= 0) {
        return { endpointReachable: false, targetFound: null, error: 'missing debug port' };
    }
    if (!targetId) {
        return { endpointReachable: false, targetFound: null, error: 'missing target id' };
    }
    const fetchImpl = options.fetchImpl || fetch;
    const timeoutMs = options.timeoutMs || 1_500;
    try {
        const versionResponse = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!versionResponse.ok) {
            return { endpointReachable: false, targetFound: null, error: `DevTools version HTTP ${versionResponse.status}` };
        }
    } catch (err) {
        return { endpointReachable: false, targetFound: null, error: errorMessage(err) };
    }
    try {
        const listResponse = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!listResponse.ok) {
            return { endpointReachable: true, targetFound: null, error: `DevTools list HTTP ${listResponse.status}` };
        }
        const targets = await listResponse.json() as Array<{ id?: string; targetId?: string; url?: string }>;
        if (!Array.isArray(targets)) {
            return { endpointReachable: true, targetFound: null, error: 'DevTools target list is not an array' };
        }
        const match = targets.find(target => target?.id === targetId || target?.targetId === targetId);
        return match
            ? { endpointReachable: true, targetFound: true, ...(typeof match.url === 'string' ? { matchedUrl: match.url } : {}) }
            : { endpointReachable: true, targetFound: false };
    } catch (err) {
        return { endpointReachable: true, targetFound: null, error: errorMessage(err) };
    }
}

/** True only when Chrome answered AND the target is still listed. */
export function isRecoverableCdpDisconnect(liveness: CdpLiveness): boolean {
    return liveness.endpointReachable === true && liveness.targetFound === true;
}

function errorMessage(err: unknown): string {
    return String((err as { message?: string })?.message || err);
}

