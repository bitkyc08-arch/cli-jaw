// ─── Slack inbound allowlist: naming a change, and recording it ──
//
// `slack.channelIds` is the list of conversations this instance can HEAR: empty
// allows every one, non-empty allows exactly those. Narrowing it can cut off the
// surface the writer is speaking through, and an agent did exactly that — after
// which nobody could tell what had happened, because nothing recorded it (#406).
//
// Refusing the write is not an option: `jaw slack setup --channel-ids` reaches
// the running server through the same PUT (slack/hot-notify.ts). Recording it is
// what was missing.
//
// Its own module because the settings FILE watcher has to record it too, and a
// watcher must not import an Express route module to do so.

import { getSecurityAuditLog } from '../security/security-audit-log.js';
import { log } from '../core/logger.js';
import { MALFORMED_SLACK_ALLOWLIST, readSlackAllowlist } from './events.js';

export type AllowlistChange = {
    kind: 'narrow' | 'widen' | 'clear';
    from: string[];
    to: string[];
};

/** How a settings write moves the allowlist, as the gate would read both sides. */
export function classifyAllowlistChange(next: unknown, current: unknown): AllowlistChange | null {
    if (!Array.isArray(next)) return null;
    // Through the gate's reader, or the record names the wrong direction. Raw
    // comparison called `[" C1 "] -> ["C1"]` a narrowing when the reach is
    // identical, and — worse — called RECOVERY from a malformed value (which
    // denies everything) a narrowing too, when it is the widest move there is.
    const to = readSlackAllowlist(next);
    const from = readSlackAllowlist(current);
    const denied = (ids: string[]) => ids.length === 1 && ids[0] === MALFORMED_SLACK_ALLOWLIST;
    if (denied(to)) {
        // The route refuses such a write, so this is unreachable through PUT.
        // Classifying it as a narrowing anyway would be wrong in the other
        // direction — it denies every channel — so say nothing rather than lie.
        return null;
    }
    // From "nothing gets through" every write is a widening, including one that
    // names a single channel.
    if (denied(from)) return { kind: 'widen', from: [], to };
    if (to.length === 0) return from.length === 0 ? null : { kind: 'clear', from, to };
    if (from.length === 0) return { kind: 'narrow', from, to };
    if (from.some(id => !to.includes(id))) return { kind: 'narrow', from, to };
    if (to.length > from.length) return { kind: 'widen', from, to };
    return null;
}

/**
 * One narrowing reaches BOTH recorders: `jaw slack setup --channel-ids` writes
 * settings.json and then hot-notifies, so the file watcher and the route each
 * see the same move and each used to append a row — one change reading as two
 * security events under two different actors.
 *
 * Collapsed on the transition within a short window, not forever: the two doors
 * are milliseconds apart, while a narrowing repeated hours later is a real
 * second event and must still be recorded.
 *
 * EVERY classified move updates this, not just the recorded ones. Skipping the
 * widenings left `[A,B]->[A]`, `[A]->[A,B]`, `[A,B]->[A]` looking like one
 * repeated transition, and the second narrowing — a genuine event, with the
 * allowlist reopened in between — went unrecorded.
 */
const AUDIT_DEDUP_WINDOW_MS = 5000;
let lastRecorded: { transition: string; at: number } | null = null;

export function resetAllowlistAuditDedupForTest(): void {
    lastRecorded = null;
}

/**
 * Note a move that is not itself recorded (a widen or a clear). It still ends
 * the state the last record described, so a later narrowing back to the same
 * list is a new event rather than an echo of the old one.
 */
export function noteAllowlistMove(change: AllowlistChange | null): void {
    if (!change || change.kind === 'narrow') return;
    lastRecorded = null;
}

/**
 * Log and record a narrowing. Non-fatal by contract: an audit write that fails
 * must not take down the settings change it is describing.
 *
 * `actor` says where the write came from — a request address for the route,
 * `settings.json` for the file watcher. Both matter: `jaw slack setup` writes
 * the file BEFORE it hot-notifies, so on a 300ms watcher debounce the reload can
 * land first and the route then sees no change left to describe.
 */
export function recordAllowlistNarrowing(change: AllowlistChange | null, actor: string): void {
    if (change?.kind !== 'narrow') {
        noteAllowlistMove(change ?? null);
        return;
    }
    const transition = `${change.from.join(',')}>${change.to.join(',')}`;
    const now = Date.now();
    if (lastRecorded
        && lastRecorded.transition === transition
        && now - lastRecorded.at < AUDIT_DEDUP_WINDOW_MS) {
        return;
    }
    lastRecorded = { transition, at: now };
    try {
        log.warn(`[slack:allowlist] narrowed to ${change.to.length} channel(s): `
            + `${change.to.join(', ')} — conversations outside this list will be ignored`);
        getSecurityAuditLog().append('settings_change', actor, {
            keys: ['slack.channelIds'],
            action: 'narrow',
            from: change.from,
            to: change.to,
        });
    } catch { /* non-fatal */ }
}
