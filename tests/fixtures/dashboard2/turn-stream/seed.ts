// 040.1 — deterministic 10k turn-stream fixture generator (seed=4048).
// Consumes shared DTOs type-only (D21: segments carry no body; message
// content/tool_log and trace detail own bodies). Distribution contract:
// devlog/_plan/260711_manager_redesign_feature_migration/040_phase4_turn_stream_renderer.md §3.
import { createHash } from 'node:crypto';
import type {
    SegmentedMessageItem,
    ThinkingMarker,
    TurnFidelity,
    TurnLifecycleSsePayload,
    TurnSegment,
    TurnSegmentStatus,
} from '../../../../src/shared/chat-events.ts';

export const FIXTURE_SEED = 4048;
export const TURN_COUNT = 10_000;
export const MESSAGE_COUNT = 10_000;

const MARKERS: ThinkingMarker[] = [
    'streaming', 'plaintext', 'encrypted', 'token_fallback', 'pre_tool_text', 'plan', 'planner',
];
const CLIS = ['claude', 'codex', 'agy', 'grok', 'opencode'] as const;
const BASE_TS = 1_783_000_000_000;

export interface TurnStreamFixture {
    seed: number;
    messages: SegmentedMessageItem[];
    lifecycle: TurnLifecycleSsePayload[];
    segments: TurnSegment[];
}

export interface FixtureStats {
    turnCount: number;
    messageCount: number;
    segmentRows: number;
    lifecycleEvents: number;
    statusTurns: Record<'done' | 'error' | 'continued' | 'interrupted', number>;
    fidelityTurns: Record<TurnFidelity, number>;
    markerRows: Record<string, number>;
    promotionTurns: number;
    grokPairTurns: number;
    openTurns: number;
    userMessages: number;
    assistantMessages: number;
}

// mulberry32 — deterministic across platforms (IEEE754 ops only).
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Deterministic per-index buckets (independent of RNG draw order).
export function terminalStatusFor(i: number): 'done' | 'error' | 'continued' | 'interrupted' {
    if (i % 20 === 1) return 'error';
    if (i % 20 === 2) return 'continued';
    if (i % 20 === 3) return 'interrupted';
    return 'done';
}
export function fidelityFor(i: number): TurnFidelity {
    const b = i % 10;
    if (b <= 3) return 'full';
    if (b <= 6) return 'coarse';
    return 'text_only';
}
export const isPromotionTurn = (i: number): boolean => i % 30 === 4;       // coarse bucket, ~334 turns
export const isGrokPairTurn = (i: number): boolean => i % 20 === 15;       // ~500 turns
export const isOpenTurn = (i: number): boolean => i % 100 === 99;          // 100 running (shimmer) turns
const hasToolSegment = (i: number): boolean => i % 2 === 0;

function cliFor(i: number): string {
    if (isGrokPairTurn(i)) return 'grok';
    if (isPromotionTurn(i)) return 'opencode';
    return CLIS[i % CLIS.length];
}

interface SegmentDraft {
    type: string;
    status: TurnSegmentStatus;
    fidelity: TurnFidelity | null;
    marker: ThinkingMarker | null;
    segmentKey: string;
    trace: boolean;
}

function draftsForTurn(i: number): SegmentDraft[] {
    const fidelity = fidelityFor(i);
    const marker = MARKERS[i % MARKERS.length];
    const open = isOpenTurn(i);
    const drafts: SegmentDraft[] = [
        { type: 'turn_start', status: 'running', fidelity, marker: null, segmentKey: 'start', trace: false },
    ];
    if (isPromotionTurn(i)) {
        // OpenCode coarse→full promotion: same segmentId re-appended at full fidelity.
        drafts.push({ type: 'thinking', status: 'running', fidelity: 'coarse', marker, segmentKey: 'think', trace: false });
        drafts.push({ type: 'thinking', status: 'done', fidelity: 'full', marker, segmentKey: 'think', trace: false });
    } else if (isGrokPairTurn(i)) {
        // Grok stable pair: exactly 2 durable rows, same segmentId, distinct turnSeq.
        drafts.push({ type: 'thinking', status: 'running', fidelity, marker, segmentKey: 'think', trace: false });
        drafts.push({ type: 'thinking', status: 'done', fidelity, marker, segmentKey: 'think', trace: false });
    } else {
        drafts.push({ type: 'thinking', status: open ? 'running' : 'done', fidelity, marker, segmentKey: 'think', trace: false });
    }
    if (hasToolSegment(i)) {
        drafts.push({ type: 'tool', status: open ? 'running' : 'done', fidelity, marker: null, segmentKey: 'tool', trace: true });
    }
    if (!open) {
        drafts.push({ type: 'assistant_text', status: 'done', fidelity, marker: null, segmentKey: 'text', trace: false });
        drafts.push({ type: 'turn_end', status: terminalStatusFor(i), fidelity, marker: null, segmentKey: 'end', trace: false });
    }
    return drafts;
}

export function generateFixture(seed: number = FIXTURE_SEED): TurnStreamFixture {
    const rng = mulberry32(seed);
    const segments: TurnSegment[] = [];
    const lifecycle: TurnLifecycleSsePayload[] = [];
    const byTurn = new Map<number, TurnSegment[]>();

    for (let i = 0; i < TURN_COUNT; i++) {
        const turnId = `fixture-turn-${String(i).padStart(5, '0')}`;
        const sessionId = `fixture-session-${i % 40}`;
        const drafts = draftsForTurn(i);
        const rows: TurnSegment[] = [];
        drafts.forEach((draft, idx) => {
            const turnSeq = idx + 1;
            const createdAt = BASE_TS + i * 1000 + turnSeq * 7;
            const row: TurnSegment = {
                turnId,
                turnSeq,
                segmentId: `${turnId}:${draft.segmentKey}`,
                sessionId,
                createdAt,
                observedAt: createdAt + (i % 5),
                providerAt: i % 3 === 0 ? createdAt - 2 : null,
                fidelity: draft.fidelity,
                thinkingMarker: draft.marker,
                type: draft.type,
                status: draft.status,
                detailRef: draft.trace ? { traceRunId: `fixture-trace-${String(i).padStart(5, '0')}`, traceSeq: 1 } : null,
            };
            rows.push(row);
            segments.push(row);
            const event = draft.type === 'turn_start' ? 'turn_start' : draft.type === 'turn_end' ? 'turn_end' : 'turn_segment';
            lifecycle.push({ topic: 'agent', event, ...row });
        });
        byTurn.set(i, rows);
    }

    const messages: SegmentedMessageItem[] = [];
    for (let i = 0; i < MESSAGE_COUNT; i++) {
        const user = i % 5 === 0;
        const turnRows = user ? [] : (byTurn.get(i) ?? []);
        const filler = Math.floor(rng() * 200);
        const createdAt = BASE_TS + i * 1000;
        messages.push({
            id: i + 1,
            role: user ? 'user' : 'assistant',
            content: user
                ? `fixture prompt ${i}`
                : `fixture answer ${i} ${'x'.repeat(filler)}`,
            cli: user ? null : cliFor(i),
            model: user ? null : `model-${i % 6}`,
            tool_log: !user && hasToolSegment(i)
                ? JSON.stringify([{ name: 'Bash', input: `echo fixture-${i}`, output: `out-${i}` }])
                : null,
            trace_run_id: !user && hasToolSegment(i) ? `fixture-trace-${String(i).padStart(5, '0')}` : null,
            turn_id: user ? null : `fixture-turn-${String(i).padStart(5, '0')}`,
            cost_usd: !user && i % 4 === 0 ? Math.round(rng() * 1000) / 100000 : null,
            duration_ms: user ? null : 500 + Math.floor(rng() * 20000),
            working_dir: '/tmp/jaw-fixture',
            created_at: new Date(createdAt).toISOString(),
            turn_segments: turnRows,
        });
    }

    return { seed, messages, lifecycle, segments };
}

// ─── Canonicalization + hash ────────────────────────────────────────

const SEGMENT_FIELDS: (keyof TurnSegment)[] = [
    'turnId', 'turnSeq', 'segmentId', 'sessionId', 'createdAt', 'observedAt',
    'providerAt', 'fidelity', 'thinkingMarker', 'type', 'status', 'detailRef',
];

function serializeSegment(row: TurnSegment): string {
    return JSON.stringify(SEGMENT_FIELDS.map(f => {
        const v = row[f];
        return f === 'detailRef' && v ? [(v as { traceRunId: string }).traceRunId, (v as { traceSeq: number }).traceSeq] : v;
    }));
}

export function segmentFromLifecycle(event: TurnLifecycleSsePayload): TurnSegment {
    const { topic: _topic, event: _event, sseReplay: _replay, ...row } = event;
    return row;
}

// Dedupe by (turnId, turnSeq), first arrival wins; sort by turnId then turnSeq.
export function canonicalize(rows: TurnSegment[]): TurnSegment[] {
    const seen = new Map<string, TurnSegment>();
    for (const row of rows) {
        const key = `${row.turnId}#${row.turnSeq}`;
        if (!seen.has(key)) seen.set(key, row);
    }
    return [...seen.values()].sort((a, b) =>
        a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : a.turnSeq - b.turnSeq);
}

export function canonicalSegmentHash(rows: TurnSegment[]): string {
    const hash = createHash('sha256');
    for (const row of canonicalize(rows)) hash.update(serializeSegment(row));
    return hash.digest('hex');
}

export function fixtureHash(fixture: TurnStreamFixture): string {
    const hash = createHash('sha256');
    hash.update(canonicalSegmentHash(fixture.segments));
    for (const m of fixture.messages) {
        hash.update(JSON.stringify([m.id, m.role, m.content, m.cli, m.model, m.tool_log,
            m.trace_run_id, m.turn_id, m.cost_usd, m.duration_ms, m.working_dir, m.created_at]));
    }
    return hash.digest('hex');
}

// ─── Arrival-order variants (must converge to the canonical hash) ───

export function duplicateVariant(events: TurnLifecycleSsePayload[]): TurnLifecycleSsePayload[] {
    const out: TurnLifecycleSsePayload[] = [];
    events.forEach((e, idx) => {
        out.push(e);
        if (idx % 97 === 0) out.push({ ...e, sseReplay: true });
    });
    return out;
}

export function reorderVariant(events: TurnLifecycleSsePayload[]): TurnLifecycleSsePayload[] {
    const out = [...events];
    for (let idx = 0; idx + 1 < out.length; idx += 2) {
        if (out[idx].turnId === out[idx + 1].turnId) {
            [out[idx], out[idx + 1]] = [out[idx + 1], out[idx]];
        }
    }
    return out;
}

export function replayGapVariant(events: TurnLifecycleSsePayload[]): TurnLifecycleSsePayload[] {
    const kept: TurnLifecycleSsePayload[] = [];
    const gapped: TurnLifecycleSsePayload[] = [];
    events.forEach((e, idx) => {
        if (idx % 211 === 0) gapped.push({ ...e, sseReplay: true });
        else kept.push(e);
    });
    return [...kept, ...gapped];
}

export function partialOverlapVariant(events: TurnLifecycleSsePayload[]): TurnLifecycleSsePayload[] {
    return reorderVariant(duplicateVariant(events));
}

// ─── Distribution stats (asserted against manifest) ─────────────────

export function computeStats(fixture: TurnStreamFixture): FixtureStats {
    const statusTurns = { done: 0, error: 0, continued: 0, interrupted: 0 };
    const fidelityTurns = { full: 0, coarse: 0, text_only: 0 };
    const markerRows: Record<string, number> = {};
    let promotionTurns = 0;
    let grokPairTurns = 0;
    let openTurns = 0;
    for (let i = 0; i < TURN_COUNT; i++) {
        if (isOpenTurn(i)) openTurns += 1;
        else statusTurns[terminalStatusFor(i)] += 1;
        fidelityTurns[fidelityFor(i)] += 1;
        if (isPromotionTurn(i)) promotionTurns += 1;
        if (isGrokPairTurn(i)) grokPairTurns += 1;
    }
    for (const row of fixture.segments) {
        if (row.thinkingMarker) markerRows[row.thinkingMarker] = (markerRows[row.thinkingMarker] ?? 0) + 1;
    }
    let userMessages = 0;
    for (const m of fixture.messages) if (m.role === 'user') userMessages += 1;
    return {
        turnCount: TURN_COUNT,
        messageCount: fixture.messages.length,
        segmentRows: fixture.segments.length,
        lifecycleEvents: fixture.lifecycle.length,
        statusTurns,
        fidelityTurns,
        markerRows,
        promotionTurns,
        grokPairTurns,
        openTurns,
        userMessages,
        assistantMessages: fixture.messages.length - userMessages,
    };
}
