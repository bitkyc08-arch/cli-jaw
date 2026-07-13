// 061 — D6 = B: jwc remains the history source of truth; dashboard2 consumes
// `session/list` summaries and `session/load` replay as a load-time
// projection. Identity contract (fixture-verified): ordered transcript
// content and toolCallId replay deterministically across loads, while chunk
// messageIds are REGENERATED per load — never treat replay messageIds as
// durable identity. This module stays light (no source-adapter import): the
// heavy adapter instance is injected so the sidebar (062) can consume
// summaries without pulling the Code implementation chunk.
import type { StoredCodeSessionInfo, CodeSessionInfo } from '../../../../src/code-mode/types.ts';
import type { TurnStreamAction } from '../turn-stream/types.ts';
import type { CodeApiClient } from './code-api-client.ts';
import type { CodeSourceAdapter } from './code-source-adapter.ts';

export interface CodeHistorySummary {
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt?: string;
    lastModified?: number;
    messageCount?: number;
}

/** list state for consumers (sidebar/history list) — never a silent empty */
export type CodeHistoryListState =
    | { state: 'loading' }
    | { state: 'ready'; summaries: CodeHistorySummary[] }
    | { state: 'empty' }
    | { state: 'unavailable'; message: string }
    | { state: 'error'; message: string };

export function toHistorySummaries(stored: readonly StoredCodeSessionInfo[]): CodeHistorySummary[] {
    return stored
        .filter(entry => entry.sessionId && entry.cwd)
        .map(entry => ({
            sessionId: entry.sessionId,
            title: entry.title || entry.firstMessage || entry.sessionId.slice(0, 8),
            cwd: entry.cwd,
            ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
            ...(entry.lastModified !== undefined ? { lastModified: entry.lastModified } : {}),
            ...(entry.messageCount !== undefined ? { messageCount: entry.messageCount } : {}),
        }));
}

export async function fetchHistorySummaries(client: CodeApiClient): Promise<CodeHistoryListState> {
    try {
        const stored = await client.listStoredSessions('all');
        const summaries = toHistorySummaries(stored);
        return summaries.length ? { state: 'ready', summaries } : { state: 'empty' };
    } catch (error: unknown) {
        return { state: 'error', message: error instanceof Error ? error.message : String(error) };
    }
}

export interface LoadedSessionHistory {
    session: CodeSessionInfo;
    actions: TurnStreamAction[];
}

/**
 * Load one stored session and assemble its replay into renderer input through
 * the injected 060 source adapter (replay seeding + overlap fence included).
 */
export async function loadSessionHistory(
    client: CodeApiClient,
    entry: { sessionId: string; cwd: string },
    adapter: CodeSourceAdapter,
): Promise<LoadedSessionHistory> {
    const session = await client.loadSession(entry.sessionId, entry.cwd);
    const records = Array.isArray(session.replayEvents) ? session.replayEvents : [];
    const actions = adapter.ingestReplay(records, { status: session.status });
    return { session, actions };
}
