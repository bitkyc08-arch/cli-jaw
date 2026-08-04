import type { CodeSessionReplayEvent } from './code-session-client';
import type { CodeEvent } from './useCodeEvents';
import { fnv1a32 } from '../lib/fnv1a';
import { addBounded } from '../lib/bounded-set';

/**
 * D3 (260803 unit, 050 phase): the dedupe key used to embed the FULL chunk
 * text, so the set retained roughly a second copy of the whole transcript and
 * grew for the session's lifetime.
 *
 * Collision domain, stated precisely: `stableId` is a message id or SSE event
 * id, and a message id is minted once per TURN — every delta of one assistant
 * turn shares it. So within a turn the text really was the discriminator, and
 * hashing it does concentrate risk there. What bounds it is that the key also
 * carries the text length, so only same-length chunks of the same turn can
 * collide: roughly 10^3 same-length items against 2^32, i.e. ~10^-4.
 *
 * The consequence of a collision is a hard drop — `shouldDropDuplicateCodeChunk`
 * returns before the append — so it is worth keeping that number honest rather
 * than calling stableId "unique".
 */
const MAX_SEEN_KEYS = 2000;

type ChunkLikeEvent = Pick<CodeEvent, 'event' | 'sessionId' | 'update' | 'sseEventId'>;
export type AssistantChunkMergeAction = 'append' | 'drop' | 'replace';

const CHUNK_EVENTS = new Set([
    'code_user_message_chunk',
    'code_agent_message_chunk',
    'code_agent_thought_chunk',
]);

export function textFromCodeChunk(update: Record<string, unknown> | undefined): string {
    const content = update?.['content'] as { type?: string; text?: string } | undefined;
    return String(content?.text ?? update?.['text'] ?? '');
}

export function messageIdFromCodeChunk(update: Record<string, unknown> | undefined): string {
    const messageId = update?.['messageId'];
    return typeof messageId === 'string' ? messageId.trim() : '';
}

export function codeChunkEventKey(event: ChunkLikeEvent, text: string): string | null {
    if (!CHUNK_EVENTS.has(event.event) || !text) return null;
    const update = event.update ?? {};
    const messageId = messageIdFromCodeChunk(update);
    const sseEventId = typeof event.sseEventId === 'string' && event.sseEventId.trim()
        ? event.sseEventId.trim()
        : '';
    const stableId = messageId ? `msg:${messageId}` : sseEventId ? `sse:${sseEventId}` : '';
    if (!stableId) return null;
    return `${event.sessionId ?? ''}:${event.event}:${stableId}:${text.length}:${fnv1a32(text)}`;
}

export function rememberCodeChunkEvents(seen: Set<string>, events: CodeSessionReplayEvent[]): void {
    for (const event of events) {
        const text = textFromCodeChunk(event.update);
        const key = codeChunkEventKey(event, text);
        // Seeding from a session replay must NOT evict its own earlier entries:
        // a replay longer than the bound would drop keys for content already on
        // screen, and the next matching live chunk would be appended again as
        // "new". Size the bound to the replay, then let the live path trim.
        if (key) addBounded(seen, key, Math.max(MAX_SEEN_KEYS, events.length));
    }
}

export function shouldDropDuplicateCodeChunk(seen: Set<string>, event: ChunkLikeEvent, text: string): boolean {
    const key = codeChunkEventKey(event, text);
    if (!key) return false;
    if (seen.has(key)) return true;
    addBounded(seen, key, MAX_SEEN_KEYS);
    return false;
}

export function isDuplicateAssistantFinalChunk(lastText: string, incomingText: string): boolean {
    const normalizedLast = lastText.trim();
    const normalizedIncoming = incomingText.trim();
    if (normalizedIncoming.length < 80) return false;
    return normalizedLast === normalizedIncoming;
}

const SNAPSHOT_OVERLAP_MIN_CHARS = 80;
const SNAPSHOT_LINE_OVERLAP_RATIO = 0.7;
const SNAPSHOT_SHINGLE_OVERLAP_RATIO = 0.78;
const SNAPSHOT_SHINGLE_SIZE = 32;
const SNAPSHOT_SHINGLE_STRIDE = 8;

function normalizeAssistantSnapshotText(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function normalizedContentLines(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(line => line.length >= 4);
}

function overlapRatio(values: string[], candidates: Set<string>): number {
    if (values.length === 0) return 0;
    let matched = 0;
    for (const value of values) {
        if (candidates.has(value)) matched += 1;
    }
    return matched / values.length;
}

function textShingles(text: string): string[] {
    const normalized = normalizeAssistantSnapshotText(text);
    if (normalized.length < SNAPSHOT_SHINGLE_SIZE) return [];
    const shingles: string[] = [];
    for (let index = 0; index <= normalized.length - SNAPSHOT_SHINGLE_SIZE; index += SNAPSHOT_SHINGLE_STRIDE) {
        shingles.push(normalized.slice(index, index + SNAPSHOT_SHINGLE_SIZE));
    }
    return shingles;
}

function hasSubstantialSnapshotOverlap(smallerText: string, largerText: string): boolean {
    const smaller = normalizeAssistantSnapshotText(smallerText);
    const larger = normalizeAssistantSnapshotText(largerText);
    if (smaller.length < SNAPSHOT_OVERLAP_MIN_CHARS || larger.length < SNAPSHOT_OVERLAP_MIN_CHARS) return false;
    if (larger.includes(smaller)) return true;

    const smallerLines = normalizedContentLines(smallerText);
    const largerLines = new Set(normalizedContentLines(largerText));
    if (smallerLines.length >= 4 && overlapRatio(smallerLines, largerLines) >= SNAPSHOT_LINE_OVERLAP_RATIO) return true;

    const smallerShingles = textShingles(smaller);
    if (smallerShingles.length < 3) return false;
    const largerShingles = new Set(textShingles(larger));
    return overlapRatio(smallerShingles, largerShingles) >= SNAPSHOT_SHINGLE_OVERLAP_RATIO;
}

export function assistantChunkMergeAction(currentText: string, incomingText: string): AssistantChunkMergeAction {
    if (!currentText || !incomingText) return 'append';
    if (currentText === incomingText) return 'drop';
    if (incomingText.startsWith(currentText)) return 'replace';
    if (currentText.startsWith(incomingText)) return 'drop';
    if (incomingText.length >= currentText.length && hasSubstantialSnapshotOverlap(currentText, incomingText)) return 'replace';
    if (currentText.length > incomingText.length && hasSubstantialSnapshotOverlap(incomingText, currentText)) return 'drop';
    return 'append';
}
