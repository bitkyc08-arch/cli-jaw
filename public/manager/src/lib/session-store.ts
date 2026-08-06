import { resilientGet } from './resilient-fetch';

const SESSION_TTL_MS = 2_000;

export type ChatSessionSummary = {
    id: string;
    seq: number;
    label: string | null;
    remoteKey?: string | null;
    source?: string;
    message_count: number;
    lastActivityAt?: string | null;
};

type SessionsPayload = { sessions?: ChatSessionSummary[]; active?: string };

export type FetchResult = {
    sessions: ChatSessionSummary[];
    activeId: string | null;
};

type SessionStoreErrorKind = { kind: 'load' } | { kind: 'switch'; seq: number };

export type SessionsSnapshot = {
    data: FetchResult | null;
    switching: boolean;
    error: { kind: 'load'; message: string } | { kind: 'switch'; seq: number; message: string } | null;
    count: number;
};

export type SessionStoreEntry = {
    generation: number;
    at: number;
    promise: Promise<FetchResult> | null;
    data: FetchResult | null;
    switching: boolean;
    lastError: SessionStoreErrorKind | null;
    errorMessage: string | null;
    snapshot: SessionsSnapshot;
    listeners: Set<() => void>;
};

type SessionStoreTestOptions = {
    fetchImpl?: typeof fetch;
    now?: () => number;
};

const entries = new Map<number, SessionStoreEntry>();
let fetchImpl: typeof fetch = (...args) => fetch(...args);
let now = (): number => Date.now();

function makeSnapshot(entry: Pick<SessionStoreEntry, 'data' | 'switching' | 'lastError' | 'errorMessage'>): SessionsSnapshot {
    let error: SessionsSnapshot['error'] = null;
    if (entry.lastError?.kind === 'load') {
        error = { kind: 'load', message: entry.errorMessage ?? 'sessions load failed' };
    } else if (entry.lastError?.kind === 'switch') {
        error = {
            kind: 'switch',
            seq: entry.lastError.seq,
            message: entry.errorMessage ?? 'session switch failed',
        };
    }
    return {
        data: entry.data,
        switching: entry.switching,
        error,
        count: entry.data?.sessions.length ?? 0,
    };
}

function createEntry(): SessionStoreEntry {
    const entry: SessionStoreEntry = {
        generation: 0,
        at: 0,
        promise: null,
        data: null,
        switching: false,
        lastError: null,
        errorMessage: null,
        snapshot: { data: null, switching: false, error: null, count: 0 },
        listeners: new Set(),
    };
    return entry;
}

function entryFor(port: number): SessionStoreEntry {
    let entry = entries.get(port);
    if (!entry) {
        entry = createEntry();
        entries.set(port, entry);
    }
    return entry;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function commit(entry: SessionStoreEntry): void {
    entry.snapshot = makeSnapshot(entry);
    for (const listener of [...entry.listeners]) listener();
}

async function fetchChatSessions(port: number): Promise<FetchResult> {
    const response = await resilientGet(`/i/${port}/api/chat-sessions`, { fetchImpl });
    if (!response.ok) throw new Error(`sessions fetch failed: ${response.status}`);
    const body = await response.json() as { ok?: boolean; data?: SessionsPayload };
    const data = body.data ?? {};
    return {
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        activeId: typeof data.active === 'string' ? data.active : null,
    };
}

async function postSessionSwitch(port: number, seq: number): Promise<void> {
    const response = await fetchImpl(`/i/${port}/api/chat-sessions/${seq}/switch`, { method: 'POST' });
    if (response.ok) return;
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || `switch failed: ${response.status}`);
}

export function subscribeSessions(port: number, callback: () => void): () => void {
    const entry = entryFor(port);
    entry.listeners.add(callback);
    return () => { entry.listeners.delete(callback); };
}

export function getSessionSnapshot(port: number): SessionsSnapshot {
    return entryFor(port).snapshot;
}

export function readSessions(port: number): Pick<SessionsSnapshot, 'data' | 'switching'> {
    const snapshot = getSessionSnapshot(port);
    return { data: snapshot.data, switching: snapshot.switching };
}

export async function loadSessions(port: number): Promise<void> {
    const entry = entryFor(port);
    if (entry.promise) {
        await entry.promise;
        return;
    }
    if (entry.data && now() - entry.at < SESSION_TTL_MS) return;

    const generation = entry.generation;
    const request = fetchChatSessions(port);
    entry.promise = request;
    try {
        const data = await request;
        // A switch invalidates older GETs. Only the current generation may commit.
        if (entry.generation !== generation) return;
        entry.data = data;
        entry.at = now();
        entry.lastError = null;
        entry.errorMessage = null;
        commit(entry);
    } catch (error) {
        if (entry.promise === request) entry.promise = null;
        if (entry.generation === generation) {
            entry.lastError = { kind: 'load' };
            entry.errorMessage = errorMessage(error);
            commit(entry);
        }
        throw error;
    } finally {
        if (entry.promise === request) entry.promise = null;
    }
}

export async function switchSession(port: number, seq: number): Promise<void> {
    const entry = entryFor(port);
    // This port-level lock is shared by every mounted consumer.
    if (entry.switching) return;
    entry.switching = true;
    entry.lastError = null;
    entry.errorMessage = null;
    commit(entry);

    try {
        try {
            await postSessionSwitch(port, seq);
        } catch (error) {
            entry.lastError = { kind: 'switch', seq };
            entry.errorMessage = errorMessage(error);
            commit(entry);
            throw error;
        }

        entry.generation++;
        entry.at = Number.NEGATIVE_INFINITY;
        entry.promise = null;
        await loadSessions(port);
    } finally {
        entry.switching = false;
        commit(entry);
    }
}

export async function retrySessions(port: number): Promise<void> {
    const lastError = entryFor(port).lastError;
    if (lastError?.kind === 'switch') {
        await switchSession(port, lastError.seq);
        return;
    }
    await loadSessions(port);
}

export function resetSessionStoreForTest(options: SessionStoreTestOptions = {}): void {
    entries.clear();
    fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    now = options.now ?? (() => Date.now());
}

export function getSessionListenerCountForTest(port: number): number {
    return entries.get(port)?.listeners.size ?? 0;
}
