import { useCallback, useEffect, useRef, useState } from 'react';
import { addBounded } from '../lib/bounded-set';
import type { ManagerEvent } from '../types';
import {
    continueJawCeoCompletion,
    fetchJawCeoState,
    refreshJawCeoEvents,
    sendJawCeoMessage,
    summarizeJawCeoCompletion,
    updateJawCeoCompletionStatus,
} from './api';
import type {
    JawCeoAuditRecord,
    JawCeoCompletion,
    JawCeoManagerEvent,
    JawCeoMessageData,
    JawCeoPublicState,
    JawCeoResponseMode,
    JawCeoToolResult,
} from './types';

const POLL_INTERVAL_MS = 5_000;

function nowIso(): string {
    return new Date().toISOString();
}

function emptyState(selectedPort: number | null): JawCeoPublicState {
    return {
        session: {
            sessionId: 'pending',
            inputMode: 'text',
            responseMode: 'text',
            selectedPort,
            openedAt: nowIso(),
            lastUserActivityAt: nowIso(),
            voiceArmed: false,
            frontendPresence: 'visible',
            autoRead: false,
        },
        transcript: [],
        watches: [],
        pending: [],
        auditTail: [],
        voice: {
            status: 'idle',
            sessionId: null,
            model: 'gpt-realtime-2',
            voice: 'marin',
            error: null,
        },
    };
}

function normalizeState(raw: Partial<JawCeoPublicState>, selectedPort: number | null): JawCeoPublicState {
    const fallback = emptyState(selectedPort);
    return {
        ...fallback,
        ...raw,
        session: {
            ...fallback.session,
            ...(raw.session ?? {}),
            selectedPort: raw.session?.selectedPort ?? selectedPort,
        },
        transcript: Array.isArray(raw.transcript) ? raw.transcript : [],
        watches: Array.isArray(raw.watches) ? raw.watches : [],
        pending: Array.isArray(raw.pending) ? raw.pending : [],
        auditTail: Array.isArray(raw.auditTail) ? raw.auditTail : [],
        voice: {
            ...fallback.voice,
            ...(raw.voice ?? {}),
        },
    };
}

function eventKey(event: JawCeoManagerEvent): string {
    if (event.kind === 'instance-completed') {
        return `${event.kind}:${event.port}:${event.requestId || ''}:${event.messageId || ''}:${event.at}`;
    }
    return `${event.kind}:${event.port}:${event.messageId}:${event.role}:${event.at}`;
}

function toJawCeoEvent(event: ManagerEvent): JawCeoManagerEvent | null {
    if (event.kind !== 'instance-message') return null;
    return {
        kind: 'instance-message',
        port: event.port,
        messageId: event.messageId,
        role: event.role,
        at: event.at,
    };
}

/** Bound for the CEO console's event dedupe set (050 D3). */
const MAX_SEEN_EVENT_KEYS = 2000;

export type UseJawCeoArgs = {
    selectedPort: number | null;
    documentVisible: boolean;
    managerEvents: ManagerEvent[];
};

export type JawCeoController = {
    state: JawCeoPublicState;
    pending: JawCeoCompletion[];
    audit: JawCeoAuditRecord[];
    busy: boolean;
    error: string | null;
    lastResponse: string | null;
    refresh: () => Promise<void>;
    sendText: (text: string, responseMode?: JawCeoResponseMode) => Promise<JawCeoToolResult<JawCeoMessageData>>;
    continueCompletion: typeof continueJawCeoCompletion;
    summarizeCompletion: typeof summarizeJawCeoCompletion;
    ackCompletion: (completionKey: string) => Promise<void>;
    dismissCompletion: (completionKey: string) => Promise<void>;
};

export function useJawCeo(args: UseJawCeoArgs): JawCeoController {
    const [state, setState] = useState<JawCeoPublicState>(() => emptyState(args.selectedPort));
    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastResponse, setLastResponse] = useState<string | null>(null);
    const seenEventKeysRef = useRef<Set<string>>(new Set());
    const stateRef = useRef(state);

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    const refresh = useCallback(async () => {
        setBusyAction(current => current || 'refresh');
        try {
            const currentState = normalizeState(await fetchJawCeoState(), args.selectedPort);
            const ports = Array.from(new Set(currentState.watches.map(watch => watch.port)));
            if (ports.length > 0) await refreshJawCeoEvents({ ports });
            const nextState = normalizeState(await fetchJawCeoState(), args.selectedPort);
            setState(nextState);
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusyAction(current => current === 'refresh' ? null : current);
        }
    }, [args.selectedPort]);

    useEffect(() => {
        if (!args.documentVisible) return undefined;
        let cancelled = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        async function tick(): Promise<void> {
            if (cancelled) return;
            await refresh();
        }
        void tick();
        timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
        };
    }, [args.documentVisible, refresh]);

    useEffect(() => {
        const freshEvents: JawCeoManagerEvent[] = [];
        for (const managerEvent of args.managerEvents) {
            const event = toJawCeoEvent(managerEvent);
            if (!event) continue;
            const key = eventKey(event);
            if (seenEventKeysRef.current.has(key)) continue;
            // Same unbounded-growth pattern as the code transcript (050 D3).
            addBounded(seenEventKeysRef.current, key, MAX_SEEN_EVENT_KEYS);
            freshEvents.push(event);
        }
        if (freshEvents.length === 0) return;
        void (async () => {
            try {
                await refreshJawCeoEvents({ events: freshEvents });
                await refresh();
            } catch (err) {
                setError((err as Error).message);
            }
        })();
    }, [args.managerEvents, refresh]);

    const sendText = useCallback(async (text: string, responseMode: JawCeoResponseMode = 'text') => {
        setBusyAction('message');
        try {
            const result = await sendJawCeoMessage({
                text,
                responseMode,
                selectedPort: args.selectedPort,
                ...(stateRef.current.session.sessionId === 'pending' ? {} : { sessionId: stateRef.current.session.sessionId }),
            });
            const response = result.data?.response || result.error?.message || result.message || 'Jaw CEO message completed.';
            setLastResponse(response);
            await refresh();
            return result;
        } catch (err) {
            const message = (err as Error).message;
            setError(message);
            throw err;
        } finally {
            setBusyAction(null);
        }
    }, [args.selectedPort, refresh]);

    const ackCompletion = useCallback(async (completionKey: string) => {
        setBusyAction(`ack:${completionKey}`);
        try {
            await updateJawCeoCompletionStatus(completionKey, 'ack');
            await refresh();
        } finally {
            setBusyAction(null);
        }
    }, [refresh]);

    const dismissCompletion = useCallback(async (completionKey: string) => {
        setBusyAction(`dismiss:${completionKey}`);
        try {
            await updateJawCeoCompletionStatus(completionKey, 'dismiss');
            await refresh();
        } finally {
            setBusyAction(null);
        }
    }, [refresh]);

    return {
        state,
        pending: state.pending,
        audit: state.auditTail,
        busy: busyAction !== null,
        error,
        lastResponse,
        refresh,
        sendText,
        continueCompletion: continueJawCeoCompletion,
        summarizeCompletion: summarizeJawCeoCompletion,
        ackCompletion,
        dismissCompletion,
    };
}
