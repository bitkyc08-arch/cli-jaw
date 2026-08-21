// Fail-closed session-tab recovery guards.
//
// Ported subset of agbrowse `web-ai/tab-recovery.mjs` (parity2 020 slice 2.3,
// catalog B3/C-10). The semantics that matter:
//   - tab liveness is tri-state: alive / dead / unknown;
//   - UNKNOWN NEVER replaces a tab — creating a new one would rebind the
//     session target and abandon a live conversation;
//   - replacement requires proven-dead PLUS a durable-safe target URL;
//   - stored/live URL compatibility is a real check, not a substring poke.

import { probeCdpLiveness } from './cdp-liveness.js';
import { isDurableConversationUrl } from './conversation-url.js';

export type TabLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Probe whether a tab target is alive via the out-of-band DevTools endpoint.
 * An unreachable endpoint or a probe error is UNKNOWN, not dead: we could not
 * observe the tab, so we may not replace it.
 */
export async function probeTabAlive(port: number, targetId: string | null | undefined): Promise<TabLiveness> {
    if (!targetId) return 'unknown';
    const liveness = await probeCdpLiveness({ port, targetId });
    if (!liveness.endpointReachable) return 'unknown';
    if (liveness.targetFound === true) return 'alive';
    if (liveness.targetFound === false) return 'dead';
    return 'unknown';
}

/** A recovery navigation target is safe only when durable (`/c/<id>`, https, known host). */
export function isSafeChatGptConversationUrl(url: string | null | undefined): boolean {
    return isDurableConversationUrl(url);
}

/** Stored vs live URL compatibility (agbrowse tab-recovery.mjs urlsCompatible). */
export function urlsCompatible(storedUrl: string | null | undefined, liveUrl: string | null | undefined): boolean {
    if (!storedUrl || !liveUrl) return false;
    if (storedUrl === liveUrl) return true;
    try {
        const a = new URL(storedUrl);
        const b = new URL(liveUrl);
        if (a.hostname !== b.hostname) return false;
        const aPath = a.pathname.replace(/\/+$/, '') || '/';
        const bPath = b.pathname.replace(/\/+$/, '') || '/';
        return aPath === bPath || aPath === '/' || bPath.startsWith(`${aPath}/`);
    } catch {
        return false;
    }
}

