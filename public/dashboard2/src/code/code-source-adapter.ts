// 060 — Code source adapter: ACP `code_*` events → TurnStreamAction. Pure
// module (no react/fetch/window). One adapter instance owns ONE Code session's
// turn/tool/message state and feeds a Code-owned TurnStore; the shared
// renderer receives only TurnSegment rows + hydrated bodies (D5 contract).
//
// Durable-row invariants (041 §4): rows are append-only, identity is
// (turnId, turnSeq); a tool/thinking lifecycle appends a NEW terminal row that
// shares the start row's segmentId. Running→Ran convergence happens in the
// display projection only (TurnRow lastPerSegment / CodeLiveTail).
//
// Dedupe policy (D5 확정 차이, doc §7): replay records and sseReplay frames
// seed/check a chunk-key set (`sessionId:event:messageId|sseEventId:text`,
// manager rule) so replay↔live overlap cannot double-append; PURE live delta
// chunks are NOT key-remembered (jwc 1.1.2 streams deltas with a stable
// messageId — remembering live delta keys would false-drop legitimately
// repeated delta text). SSE ids restart per process and are never durable.
import type {
    SegmentedMessageItem,
    TurnLifecycleSsePayload,
    TurnSegment,
    TurnSegmentStatus,
} from '../../../../src/shared/chat-events.ts';
import type { TurnStreamAction } from '../turn-stream/types.ts';
import {
    chunkText,
    classifyJwcPayload,
    classifyReplayRecord,
    type JwcCodeEvent,
    type JwcPermissionEvent,
    type JwcSessionUpdateEvent,
    type AcpSessionUpdate,
} from './code-event-types.ts';

export interface CodeAdapterTelemetry {
    unknownUpdateKinds: Record<string, number>;
    unknownToolStatuses: Record<string, number>;
    ignoredPayloads: number;
    droppedDuplicates: number;
}

export interface CodeSourceAdapterOptions {
    /** permission side-channel — never becomes a TurnSegment */
    onPermission?(event: JwcPermissionEvent): void;
    /** monotonic clock injection for tests */
    now?(): number;
}

export interface ReplaySessionInfo {
    /** CodeSessionInfo.status — loaded sessions reconstruct as 'idle' */
    status?: string | undefined;
}

export interface CodeSourceAdapter {
    /** live SSE payload from the shared 'jwc' subscription */
    ingestLive(payload: unknown): TurnStreamAction[];
    /** session/load replayEvents drain (seeded before live events) */
    ingestReplay(records: readonly unknown[], info?: ReplaySessionInfo): TurnStreamAction[];
    /** local prompt accept (REST /prompt ok) — opens the turn + user echo */
    notePromptAccepted(promptText: string): TurnStreamAction[];
    telemetry(): CodeAdapterTelemetry;
}

interface OpenSegmentRun {
    segmentId: string;
    /** identity key: messageId when present, contiguous-run otherwise */
    key: string;
    buffer: string;
}

interface ToolEntry {
    segmentId: string;
    collab: boolean;
    startEmitted: boolean;
    terminalEmitted: boolean;
    traceSeq: number;
}

interface ActiveTurn {
    turnId: string;
    runId: string;
    nextSeq: number;
    startedAt: number;
    /** who opened the turn — sseReplay terminals may only close 'replay' turns */
    origin: 'local' | 'live' | 'replay';
    assistant: OpenSegmentRun | null;
    thought: OpenSegmentRun | null;
    planSeen: boolean;
    tools: Map<string, ToolEntry>;
    toolOrdinal: number;
}

const TERMINAL_EVENTS: Record<string, TurnSegmentStatus> = {
    code_turn_done: 'done',
    code_session_error: 'error',
    code_session_cancelled: 'interrupted',
    code_cancelled: 'interrupted',
    code_child_exit: 'interrupted',
};

export function createCodeSourceAdapter(
    sessionId: string,
    options: CodeSourceAdapterOptions = {},
): CodeSourceAdapter {
    const now = options.now ?? (() => Date.now());
    let turnOrdinal = 0;
    let active: ActiveTurn | null = null;
    let legacyId = 0;
    let userRun: { key: string; legacyId: number; buffer: string; createdAt: number } | null = null;
    /** strictly increasing ms so transcript interleave order is stable */
    let lastTs = 0;
    const seenChunkKeys = new Set<string>();
    // toolCallId identity is session-scoped: a replayed tool_call must not
    // re-emit a running row after the replay drain closed its turn (D5
    // messageId/toolCallId-first dedupe with restart fallback)
    const seenToolKeys = new Set<string>();
    // 061 D6 — bounded post-load overlap fence: session/load regenerates chunk
    // messageIds, so id-keyed dedupe cannot match SSE-ring replays of the same
    // historical events. During the overlap phase (drain end → first NON-replay
    // frame of any class, or exhaustion) sseReplay chunks/plans matching a
    // consumable content fingerprint are dropped. notePromptAccepted does NOT
    // close the phase (an accepted prompt can outrun queued replay frames).
    let overlapActive = false;
    const overlapFingerprints = new Map<string, number>();
    const telemetry: CodeAdapterTelemetry = {
        unknownUpdateKinds: {},
        unknownToolStatuses: {},
        ignoredPayloads: 0,
        droppedDuplicates: 0,
    };

    function nextTs(): number {
        const t = now();
        lastTs = t > lastTs ? t : lastTs + 1;
        return lastTs;
    }

    function count(map: Record<string, number>, key: string): void {
        map[key] = (map[key] ?? 0) + 1;
    }

    function overlapFingerprintOf(update: AcpSessionUpdate, event: `code_${string}`): string | null {
        const kind = update.sessionUpdate;
        if (kind === 'user_message_chunk' || kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
            return `${sessionId}:${event}:${chunkText(update.content)}`;
        }
        if (kind === 'plan') return `${sessionId}:code_plan`;
        return null;
    }

    function closeOverlapPhase(): void {
        overlapActive = false;
        overlapFingerprints.clear();
    }

    function row(
        turn: ActiveTurn,
        type: TurnSegment['type'],
        status: TurnSegmentStatus,
        segmentId: string,
        extra?: Partial<TurnSegment>,
    ): TurnStreamAction {
        const ts = nextTs();
        const segment: TurnSegment = {
            turnId: turn.turnId,
            turnSeq: turn.nextSeq++,
            segmentId,
            sessionId,
            createdAt: ts,
            observedAt: ts,
            providerAt: null,
            fidelity: null,
            thinkingMarker: null,
            type,
            status,
            detailRef: { traceRunId: turn.runId, traceSeq: turn.toolOrdinal },
            ...extra,
        };
        const event = type === 'turn_start' ? 'turn_start' : type === 'turn_end' ? 'turn_end' : 'turn_segment';
        const payload: TurnLifecycleSsePayload = { topic: 'jwc-adapter', event, ...segment };
        return { kind: 'lifecycle', payload };
    }

    function openTurn(origin: ActiveTurn['origin']): { turn: ActiveTurn; actions: TurnStreamAction[] } {
        const actions: TurnStreamAction[] = [];
        if (active) return { turn: active, actions };
        turnOrdinal += 1;
        const turnId = `code:${sessionId}:${String(turnOrdinal).padStart(8, '0')}`;
        const turn: ActiveTurn = {
            turnId,
            runId: `codeturn:${turnId}`,
            nextSeq: 0,
            startedAt: 0,
            origin,
            assistant: null,
            thought: null,
            planSeen: false,
            tools: new Map(),
            toolOrdinal: 0,
        };
        active = turn;
        actions.push(row(turn, 'turn_start', 'running', `${turnId}:start`));
        turn.startedAt = lastTs;
        return { turn, actions };
    }

    function closeThought(turn: ActiveTurn, actions: TurnStreamAction[]): void {
        if (!turn.thought) return;
        actions.push(row(turn, 'thinking', 'done', turn.thought.segmentId, {
            fidelity: 'full',
            thinkingMarker: 'streaming',
        }));
        turn.thought = null;
    }

    function closeTurn(status: TurnSegmentStatus, actions: TurnStreamAction[]): void {
        const turn = active;
        if (!turn) return;
        closeThought(turn, actions);
        if (turn.planSeen) {
            actions.push(row(turn, 'thinking', 'done', `codeplan:${turn.turnId}`, {
                fidelity: 'full',
                thinkingMarker: 'plan',
            }));
            turn.planSeen = false;
        }
        if (turn.assistant) {
            actions.push(row(turn, 'assistant_text', 'done', turn.assistant.segmentId));
        }
        actions.push(row(turn, 'turn_end', status, `${turn.turnId}:end`));
        // durable body commit (message provenance beats live — reducer merge)
        const text = turn.assistant?.buffer ?? '';
        legacyId -= 1;
        const message: SegmentedMessageItem = {
            id: legacyId,
            role: 'assistant',
            content: text,
            cli: 'jwc',
            model: null,
            tool_log: null,
            trace_run_id: turn.runId,
            turn_id: turn.turnId,
            cost_usd: null,
            duration_ms: null,
            working_dir: null,
            created_at: new Date(nextTs()).toISOString(),
            turn_segments: [],
        };
        actions.push({ kind: 'history_page', messages: [message] });
        actions.push({ kind: 'agent_done', traceRunId: turn.runId, text });
        active = null;
        userRun = null;
    }

    function emitUserMessage(text: string, replay: boolean, key: string | null, origin: ActiveTurn['origin']): TurnStreamAction[] {
        const actions: TurnStreamAction[] = [];
        const runKey = key ?? 'contiguous';
        if (userRun && userRun.key === runKey && key !== null) {
            // additional chunk of the SAME user message run — cumulative text
            userRun.buffer += text;
        } else if (userRun && key === null && active === null) {
            userRun.buffer += text;
        } else {
            // a NEW distinct user message run
            if (replay && active) {
                // a later prompt is definitive evidence the prior turn ended
                closeTurn('done', actions);
            }
            legacyId -= 1;
            userRun = { key: runKey, legacyId, buffer: text, createdAt: nextTs() };
        }
        actions.push({
            kind: 'history_page',
            messages: [{
                id: userRun.legacyId,
                role: 'user',
                content: userRun.buffer,
                cli: 'jwc',
                model: null,
                tool_log: null,
                trace_run_id: null,
                turn_id: null,
                cost_usd: null,
                duration_ms: null,
                working_dir: null,
                created_at: new Date(userRun.createdAt).toISOString(),
                turn_segments: [],
            }],
        });
        if (!active) actions.push(...openTurn(origin).actions);
        return actions;
    }

    function chunkKey(event: JwcSessionUpdateEvent, text: string): string | null {
        const stable = event.update.messageId ?? event.sseEventId;
        if (!stable || !text) return null;
        return `${event.sessionId}:${event.event}:${stable}:${text}`;
    }

    function toolKeyOf(update: AcpSessionUpdate): string | null {
        return update.toolCallId ?? update['id'] as string | undefined ?? update.name ?? null;
    }

    function isTaskCall(update: AcpSessionUpdate): boolean {
        const raw = update.rawInput ?? update.input;
        if (typeof raw !== 'object' || raw === null) return false;
        const record = raw as Record<string, unknown>;
        return record['agent_type'] === 'task' || record['agentType'] === 'task';
    }

    function applySessionUpdate(event: JwcSessionUpdateEvent, replay: boolean, origin: ActiveTurn['origin']): TurnStreamAction[] {
        const update = event.update;
        const kind = update.sessionUpdate;
        const actions: TurnStreamAction[] = [];

        // replay/SSE-replay overlap guard (manager chunk-key rule)
        if (kind === 'user_message_chunk' || kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
            const key = chunkKey(event, chunkText(update.content));
            if (key) {
                if (replay || event.sseReplay) {
                    if (seenChunkKeys.has(key)) {
                        telemetry.droppedDuplicates += 1;
                        return actions;
                    }
                    seenChunkKeys.add(key);
                } else if (seenChunkKeys.has(key)) {
                    telemetry.droppedDuplicates += 1;
                    return actions;
                }
            }
        }

        switch (kind) {
            case 'user_message_chunk': {
                return emitUserMessage(chunkText(update.content), replay, update.messageId ?? null, origin);
            }
            case 'agent_thought_chunk': {
                const { turn, actions: opened } = openTurn(origin);
                actions.push(...opened);
                const key = update.messageId ?? 'thought:contiguous';
                if (!turn.thought || turn.thought.key !== key) {
                    closeThought(turn, actions);
                    turn.thought = { segmentId: `codethought:${turn.turnId}:${key}`, key, buffer: '' };
                    actions.push(row(turn, 'thinking', 'running', turn.thought.segmentId, {
                        fidelity: 'full',
                        thinkingMarker: 'streaming',
                    }));
                }
                turn.thought.buffer += chunkText(update.content);
                return actions;
            }
            case 'plan': {
                const { turn, actions: opened } = openTurn(origin);
                actions.push(...opened);
                if (!turn.planSeen) {
                    turn.planSeen = true;
                    actions.push(row(turn, 'thinking', 'running', `codeplan:${turn.turnId}`, {
                        fidelity: 'full',
                        thinkingMarker: 'plan',
                    }));
                }
                return actions;
            }
            case 'agent_message_chunk': {
                const { turn, actions: opened } = openTurn(origin);
                actions.push(...opened);
                closeThought(turn, actions);
                const key = update.messageId ?? 'assistant:contiguous';
                const text = chunkText(update.content);
                if (!turn.assistant || turn.assistant.key !== key) {
                    if (turn.assistant) {
                        actions.push(row(turn, 'assistant_text', 'done', turn.assistant.segmentId));
                    }
                    turn.assistant = { segmentId: `codemsg:${turn.turnId}:${key}`, key, buffer: '' };
                    actions.push(row(turn, 'assistant_text', 'running', turn.assistant.segmentId));
                }
                // jwc 1.1.2 streams deltas; snapshot-style repeats are dropped
                // or reduced to their unseen suffix (manager merge classes)
                let delta = text;
                if (text && turn.assistant.buffer) {
                    if (turn.assistant.buffer === text) delta = '';
                    else if (text.startsWith(turn.assistant.buffer)) delta = text.slice(turn.assistant.buffer.length);
                    else if (turn.assistant.buffer.endsWith(text)) delta = '';
                }
                if (delta) {
                    turn.assistant.buffer += delta;
                    actions.push({
                        kind: 'body_chunk',
                        traceRunId: turn.runId,
                        text: delta,
                        sseReplay: replay || event.sseReplay,
                    });
                }
                return actions;
            }
            case 'tool_call': {
                const knownKey = toolKeyOf(update);
                if (knownKey && seenToolKeys.has(knownKey)) {
                    telemetry.droppedDuplicates += 1;
                    return actions;
                }
                const { turn, actions: opened } = openTurn(origin);
                actions.push(...opened);
                closeThought(turn, actions);
                const toolKey = toolKeyOf(update) ?? `tool:${turn.toolOrdinal}`;
                let entry = turn.tools.get(toolKey);
                if (entry?.startEmitted) {
                    telemetry.droppedDuplicates += 1;
                    return actions;
                }
                if (knownKey) seenToolKeys.add(knownKey);
                turn.toolOrdinal += 1;
                const collab = isTaskCall(update);
                const label = update.title ?? update.name ?? 'task';
                const segmentId = collab
                    ? `collab:${encodeURIComponent(label)}:${encodeURIComponent(toolKey)}`
                    : `codetool:${turn.turnId}:${toolKey}`;
                entry = { segmentId, collab, startEmitted: true, terminalEmitted: false, traceSeq: turn.toolOrdinal };
                turn.tools.set(toolKey, entry);
                actions.push(row(turn, collab ? 'collab' : 'tool', 'running', segmentId, {
                    detailRef: { traceRunId: turn.runId, traceSeq: entry.traceSeq },
                }));
                return actions;
            }
            case 'tool_call_update': {
                const turn = active;
                if (!turn) { telemetry.ignoredPayloads += 1; return actions; }
                const toolKey = toolKeyOf(update);
                const entry = toolKey ? turn.tools.get(toolKey) : undefined;
                if (!entry || entry.terminalEmitted) {
                    if (!entry) telemetry.ignoredPayloads += 1;
                    else telemetry.droppedDuplicates += 1;
                    return actions;
                }
                const status = update.status ?? '';
                if (status === 'completed' || status === 'failed' || status === 'cancelled') {
                    entry.terminalEmitted = true;
                    const terminal: TurnSegmentStatus = status === 'completed' ? 'done' : 'error';
                    actions.push(row(turn, entry.collab ? 'collab' : 'tool', terminal, entry.segmentId, {
                        detailRef: { traceRunId: turn.runId, traceSeq: entry.traceSeq },
                    }));
                } else if (status !== 'pending' && status !== 'in_progress' && status !== 'running') {
                    // unknown status: open union preserved as telemetry only
                    count(telemetry.unknownToolStatuses, status || '(empty)');
                }
                return actions;
            }
            default: {
                count(telemetry.unknownUpdateKinds, kind);
                return actions;
            }
        }
    }

    function applyEvent(event: JwcCodeEvent, replay: boolean): TurnStreamAction[] {
        const sseReplay = event.class !== 'permission' && event.sseReplay === true;
        // overlap-phase lifecycle (061 D6): the first NON-replay frame of any
        // class proves the SSE replay prefix ended — close the fence BEFORE
        // applying the frame. sseReplay chunks/plans matching a seeded
        // fingerprint are consumed (dropped) while the phase is open.
        if (overlapActive && !replay) {
            if (!sseReplay) {
                closeOverlapPhase();
            } else if (event.class === 'session_update') {
                const fingerprint = overlapFingerprintOf(event.update, event.event);
                const remaining = fingerprint ? overlapFingerprints.get(fingerprint) ?? 0 : 0;
                if (fingerprint && remaining > 0) {
                    if (remaining === 1) overlapFingerprints.delete(fingerprint);
                    else overlapFingerprints.set(fingerprint, remaining - 1);
                    if (overlapFingerprints.size === 0) closeOverlapPhase();
                    telemetry.droppedDuplicates += 1;
                    return [];
                }
            }
        }
        if (event.class === 'permission') {
            options.onPermission?.(event);
            return [];
        }
        const origin: ActiveTurn['origin'] = replay || sseReplay ? 'replay' : 'live';
        if (event.class === 'lifecycle') {
            if (event.sessionId && event.sessionId !== sessionId && event.event !== 'code_child_exit') {
                telemetry.ignoredPayloads += 1;
                return [];
            }
            const terminal = TERMINAL_EVENTS[event.event];
            if (terminal !== undefined) {
                if (!active) {
                    // duplicate terminals converge to the FIRST terminal row
                    telemetry.droppedDuplicates += 1;
                    return [];
                }
                // stale-terminal fence: an sseReplay terminal may only close a
                // turn that was itself opened by replayed events — never a
                // local prompt turn or a live-origin turn
                if (sseReplay && active.origin !== 'replay') {
                    telemetry.droppedDuplicates += 1;
                    return [];
                }
                const actions: TurnStreamAction[] = [];
                closeTurn(terminal, actions);
                return actions;
            }
            telemetry.ignoredPayloads += 1;
            return [];
        }
        if (event.sessionId !== sessionId) {
            telemetry.ignoredPayloads += 1;
            return [];
        }
        return applySessionUpdate(event, replay, origin);
    }

    return {
        ingestLive(payload) {
            const event = classifyJwcPayload(payload);
            if (!event) {
                telemetry.ignoredPayloads += 1;
                return [];
            }
            return applyEvent(event, false);
        },
        ingestReplay(records, info) {
            const actions: TurnStreamAction[] = [];
            for (const record of records) {
                const event = classifyReplayRecord(record, sessionId);
                if (!event) {
                    telemetry.ignoredPayloads += 1;
                    continue;
                }
                if (event.class === 'session_update') {
                    const fingerprint = overlapFingerprintOf(event.update, event.event);
                    if (fingerprint) {
                        overlapFingerprints.set(fingerprint, (overlapFingerprints.get(fingerprint) ?? 0) + 1);
                    }
                }
                actions.push(...applyEvent(event, true));
            }
            // drain end: close a still-open turn ONLY with not-running
            // evidence. 'interrupted' is a conservative reconstruction status
            // (loaded sessions rebuild as idle), not an observed cancellation.
            if (active && info && info.status !== 'streaming' && info.status !== 'busy') {
                closeTurn('interrupted', actions);
            }
            if (overlapFingerprints.size > 0) overlapActive = true;
            return actions;
        },
        notePromptAccepted(promptText) {
            const actions: TurnStreamAction[] = [];
            if (active) closeTurn('done', actions);
            actions.push(...emitUserMessage(promptText, false, `local:${legacyId}`, 'local'));
            return actions;
        },
        telemetry() {
            return telemetry;
        },
    };
}
