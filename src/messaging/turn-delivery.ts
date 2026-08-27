// ─── Turn Delivery Claims ────────────────────────────
// One inbound turn has TWO ways to put the answer in front of the user, and
// until this module existed neither knew about the other:
//
//   1. the AGENT itself, calling POST /api/channel/send as a tool mid-turn;
//   2. the DISPATCH path, posting the collected final text when the turn settles.
//
// When the agent takes the first route the user reads the same answer twice.
// The prompt actively encourages the pairing that makes it visible ("Always
// provide normal text response alongside file delivery"), so this is the
// ordinary case for any turn that returns an image, not an exotic one.
//
// WHY NOT THE OBVIOUS KEYS
//
// A per-turn nonce echoed by the agent would be exact, and unreliable for the
// same reason #474 was: it only works when the model remembers to echo it.
// `turn_conversation` is an ADDRESS, not an identity — two consecutive turns in
// one thread serialize to identical bytes. And a bare text-equality cache is
// unsound in both directions, because the dispatch text is transformed on its
// way out (interview-tracker stripping, elicitation normalization, a possible
// stall notice, output policy) by a different sequence than the self-send.
//
// So the key is what the SERVER already knows without the model's cooperation:
// which conversation was addressed, and when. A self-delivery is remembered
// against its target for a bounded window; the dispatch path asks, just before
// posting, whether this turn's answer is already on screen.
//
// FAIL-OPEN, DELIBERATELY
//
// A duplicated answer is annoying. A SWALLOWED answer is the user losing work
// they were waiting on, and it is silent. Every uncertain case therefore
// resolves toward posting: an unrecorded send, an expired window, a digest that
// does not match, a target that does not match. Suppression happens only when
// the recorded text and the outgoing text agree after normalization — that is,
// only when the user demonstrably already has these exact words.
//
// ORDERING ACROSS TURNS
//
// Two turns addressing the SAME conversation cannot interleave here: same-target
// turns share a scope and serialize through the session lane
// (`src/orchestrator/session-lanes.ts`), which runs one turn per scope. Turns to
// DIFFERENT conversations produce different target keys and cannot see each
// other's claims at all. The safety of this module therefore rests on that lane
// invariant plus consumption below — worth knowing before anyone raises
// `maxConcurrent` per scope, because that is the assumption it would weaken.

import { createHash } from 'node:crypto';
import type { MessengerChannel, RemoteTarget } from './types.js';
import { buildRemoteSessionKey } from './session-key.js';

/** Outer bound on how long a self-delivery is remembered.
 *
 *  This is a memory bound, NOT the suppression rule. The rule is the turn
 *  anchor below: a claim can only suppress the turn it was made during. Without
 *  that anchor a TTL alone degrades the key to target+text, so a later turn
 *  answering "완료했습니다" a second time would be swallowed — a silence, which is
 *  the failure this module exists to avoid causing. */
export const SELF_DELIVERY_TTL_MS = 15 * 60_000;

/** Bound on remembered deliveries, so a busy server cannot grow this without
 *  limit. Oldest-first eviction, as in `dedupe.ts`. */
const MAX_TRACKED = 512;

export type SelfDeliveryRecord = {
    /** Session key of the conversation the send addressed. */
    targetKey: string;
    channel: MessengerChannel;
    /** Digest of the normalized text that was actually displayed. Never null:
     *  a send with nothing readable to match is not recorded at all. */
    digest: string;
    /** Position in the strictly increasing sequence. THIS, not `at`, decides
     *  whether the claim belongs to the turn that is asking. */
    seq: number;
    at: number;
};

const records: SelfDeliveryRecord[] = [];

/**
 * A strictly increasing sequence number, and the ONLY thing that decides which
 * turn a claim belongs to.
 *
 * Wall-clock time cannot carry that decision. `Date.now()` moves backwards on an
 * NTP correction, which makes an older claim look no-older-than a turn that
 * began after it — and that turn's answer is then swallowed. Clamping the clock
 * forward does not fix it either: after a rollback the clamp returns the
 * previous maximum, so the stale claim and the new turn read the SAME value and
 * a `>=` comparison still lets the claim through.
 *
 * A counter has no such failure: every call returns a value strictly greater
 * than the last, so "recorded after this turn began" stays decidable whatever
 * the system clock does. Timestamps stay on the record for the TTL only, where
 * being wrong costs a duplicate instead of a silence.
 */
let sequence = 0;
export function nextDeliverySeq(): number {
    sequence += 1;
    return sequence;
}

/**
 * An anchor for a turn that has not started yet.
 *
 * A QUEUED turn must not anchor at enqueue time. The turn ahead of it is still
 * running and can record a claim afterwards, which would then sort as "after
 * this turn began" and suppress its answer — a silence. But the queued handler
 * is a listener armed at queue time; it has no natural moment of its own.
 *
 * So the anchor is latched by the signal that the run actually started, and
 * until that happens it reads as `Infinity` — an anchor nothing can be newer
 * than, so nothing is suppressed. Both the unlatched and the mis-ordered case
 * therefore fail toward posting.
 */
export function pendingDeliveryAnchor(): { latch(): void; value(): number } {
    let latched: number | null = null;
    return {
        latch(): void {
            latched ??= nextDeliverySeq();
        },
        value(): number {
            return latched ?? Number.POSITIVE_INFINITY;
        },
    };
}

/**
 * Compare-ready form of an outgoing message.
 *
 * Both sides of the comparison run this, so the transforms that differ between
 * the two paths (trailing whitespace, blank-line runs, CRLF) cannot masquerade
 * as a different message. It deliberately does NOT strip markdown or
 * punctuation: two messages that differ only in emphasis are still two
 * different messages, and treating them as one would suppress a real answer.
 */
export function normalizeDeliveryText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Digest of the normalized text. Empty text has no digest: a send with nothing
 *  in it never suppresses anything. */
export function deliveryDigest(text: string | undefined | null): string | null {
    if (typeof text !== 'string') return null;
    const normalized = normalizeDeliveryText(text);
    if (!normalized) return null;
    return createHash('sha256').update(normalized).digest('hex');
}

/** Key a target for comparison. Reuses the queue/session key so "same
 *  conversation" means the same thing here as everywhere else — including the
 *  thread-vs-channel distinction, which matters: a thread reply and a channel
 *  post are different destinations. */
export function deliveryTargetKey(target: RemoteTarget | null | undefined): string | null {
    if (!target?.channel || !target.targetId) return null;
    try {
        return buildRemoteSessionKey(target);
    } catch {
        return null;
    }
}

function evict(now: number): void {
    // A rolled-back clock can make `now - at` negative; only a genuinely aged
    // entry is dropped, and the size cap below bounds the rest regardless.
    while (records.length && now - records[0]!.at > SELF_DELIVERY_TTL_MS) records.shift();
    while (records.length > MAX_TRACKED) records.shift();
}

/**
 * Remember that the AGENT delivered something itself.
 *
 * Called only for sends that arrived over the HTTP surface an agent uses. The
 * distinction is load-bearing: `sendChannelOutput` is also how heartbeats,
 * reminders, alert escalation and the target-reply forwarder deliver, and
 * recording those would let an unrelated background message suppress a real
 * answer.
 */
export function recordSelfDelivery(input: {
    target: RemoteTarget | null | undefined;
    channel: MessengerChannel;
    text?: string | null;
    now?: number;
}): SelfDeliveryRecord | null {
    const targetKey = deliveryTargetKey(input.target);
    if (!targetKey) return null;
    const digest = deliveryDigest(input.text);
    // A send with no text delivers nothing this module can match later: file
    // bytes cannot be proven delivered from a path, so a file-only send records
    // nothing rather than sitting in the table where it can only cause pressure.
    if (!digest) return null;
    const now = input.now ?? Date.now();
    const record: SelfDeliveryRecord = {
        targetKey, channel: input.channel, digest,
        seq: nextDeliverySeq(), at: now,
    };
    records.push(record);
    evict(now);
    return record;
}

/**
 * Has THIS answer already been delivered to THIS conversation by the agent?
 *
 * Returns false for every uncertain case. The caller uses it to skip a
 * redundant post, never to decide whether the turn succeeded.
 */
export function wasSelfDelivered(input: {
    target: RemoteTarget | null | undefined;
    text: string | undefined | null;
    /** The sequence value read when the CURRENT turn began
     *  (`nextDeliverySeq()`). A claim recorded before that belongs to an earlier
     *  turn and must not suppress this one: the user asking the same question
     *  twice deserves two answers. Required — without it the match degrades to
     *  "anyone ever said this here", which silently loses replies. */
    since: number;
    now?: number;
}): boolean {
    const targetKey = deliveryTargetKey(input.target);
    const digest = deliveryDigest(input.text);
    if (!targetKey || !digest || !Number.isFinite(input.since)) return false;
    const now = input.now ?? Date.now();
    evict(now);
    const index = records.findIndex(record =>
        record.targetKey === targetKey
        && record.digest === digest
        && record.seq > input.since
        && now - record.at <= SELF_DELIVERY_TTL_MS);
    if (index === -1) return false;
    // Consumed, not merely read. A claim answers for exactly one post; leaving
    // it in place would let one self-send suppress every later turn that
    // happened to produce the same words.
    records.splice(index, 1);
    return true;
}

/** Test seam for the sequence. Never called in production paths. */
export function resetDeliverySeq(): void {
    sequence = 0;
}

/** Test seam. Never called in production paths. */
export function resetTurnDeliveryState(): void {
    records.length = 0;
}

/** Diagnostics only. */
export function trackedSelfDeliveries(): number {
    return records.length;
}
