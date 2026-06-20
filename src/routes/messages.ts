// ─── Messages read API ────────────────────────────────
// Extracted from server.ts in Phase 2 (devlog 260609, 07 §3.4).
// H08-H11 share getActiveChatSession() — keep in one module.
// (Not to be confused with routes/messaging.ts — channel transport routes.)

import type { Router } from 'express';
import { ok } from '../http/response.js';
import {
    getMessages, getMessagesWithTrace, getRecentMessagesAll, getRecentMessagesAllWithTrace,
    searchMessages, getMessageContext, getMessageCount,
    getLatestAssistantMessage, getLatestDashboardActivityMessage,
} from '../core/db.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { dashboardActivityTitleFromExcerpt } from '../core/message-summary.js';
import { sanitizeSerializedToolLog, serializeSanitizedToolLog, parseToolLogBounded } from '../shared/tool-log-sanitize.js';
import { isAgentBusy } from '../agent/spawn.js';
import { listToolEntriesForMessage } from '../trace/store.js';
import { HYDRATE_TOOL_CARDS_FROM_TRACE } from '../core/config.js';

// Option D (devlog 260620 Phase 3): tool cards for a finished message come from
// trace_events (durable, uncapped) when the rollout flag is on AND the message has a
// linked trace run with tools; otherwise the messages.tool_log blob (legacy/fallback).
// `fromTrace` is a parameter so both branches stay unit-testable.
export function resolveToolLog(
    messageId: unknown,
    blobToolLog: string | null | undefined,
    fromTrace: boolean = HYDRATE_TOOL_CARDS_FROM_TRACE,
): string | null {
    if (fromTrace && Number.isInteger(messageId) && (messageId as number) > 0) {
        const traceTools = listToolEntriesForMessage(messageId as number);
        if (traceTools.length) {
            // Boss tools come from trace_events (durable, uncapped). Worker mirrors
            // (isEmployee) stay sourced from the blob, where Phase 1 already preserves them
            // sanitized — so enabling the flag never drops worker cards. Union by stepRef.
            // (Folding worker child runs from trace via parent_run_id is the purer Option D
            // path but needs a cross-process linkage write; the blob mirror is display-
            // equivalent and ships the flag safely now — devlog 260620 doc 20/31.)
            const blobWorkers = parseToolLogBounded(blobToolLog).filter((t) => t.isEmployee === true);
            if (!blobWorkers.length) return serializeSanitizedToolLog(traceTools);
            const seen = new Set<string>();
            const merged: unknown[] = [];
            for (const t of [...traceTools, ...blobWorkers] as { stepRef?: unknown }[]) {
                const ref = typeof t.stepRef === 'string' && t.stepRef ? t.stepRef : null;
                if (ref) { if (seen.has(ref)) continue; seen.add(ref); }
                merged.push(t);
            }
            return serializeSanitizedToolLog(merged);
        }
    }
    return sanitizeSerializedToolLog(blobToolLog);
}

export function registerMessageRoutes(app: Router): void {
    app.get('/api/messages', (req, res) => {
        const includeTrace = ['1', 'true', 'yes'].includes(String(req.query["includeTrace"] || '').toLowerCase());
        // Optional recent-window: `?limit=N` returns only the most recent N messages
        // (still ascending) so the chat boot/instance-switch payload stays small.
        // Absent/invalid limit preserves the legacy full-history behavior.
        const limitRaw = Number(req.query["limit"]);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 5000) : 0;
        const sessionId = getActiveChatSession();
        let rows: unknown[];
        if (limit > 0) {
            rows = (includeTrace ? getRecentMessagesAllWithTrace.all(sessionId, limit) : getRecentMessagesAll.all(sessionId, limit)).reverse();
        } else {
            rows = includeTrace ? getMessagesWithTrace.all(sessionId) : getMessages.all(sessionId);
        }
        const safeRows = (rows as Record<string, unknown>[]).map(row => ({
            ...row,
            tool_log: resolveToolLog(row["id"], row["tool_log"] as string | null | undefined),
        }));
        ok(res, safeRows);
    });

    app.get('/api/messages/count', (_req, res) => {
        const row = getMessageCount.get(getActiveChatSession()) as { count: number } | undefined;
        ok(res, { count: row?.count ?? 0 });
    });

    app.get('/api/messages/search', (req, res) => {
        const q = String(req.query['q'] || '').trim();
        if (!q) return ok(res, []);
        const limit = Math.min(Math.max(Number(req.query['limit']) || 20, 1), 50);
        const daysRaw = Number(req.query['days']);
        const days = (daysRaw > 0 && daysRaw <= 365) ? daysRaw : null;
        const recentRaw = Number(req.query['recent']);
        const recent = (recentRaw > 0 && recentRaw <= 5000) ? recentRaw : null;
        const contextRange = Math.min(Math.max(Number(req.query['context']) || 0, 0), 5);
        const session_id = getActiveChatSession();
        const rows = searchMessages.all({ q, limit, session_id, days, recent }) as Record<string, unknown>[];
        const results = rows.map(row => {
            const entry: Record<string, unknown> = {
                id: row['id'],
                role: row['role'],
                content: row['content'],
                cli: row['cli'],
                match_field: row['match_field'],
                tool_log: resolveToolLog(row['id'], row['tool_log'] as string | null | undefined),
                created_at: row['created_at'],
            };
            if (contextRange > 0) {
                entry['context'] = getMessageContext.all({
                    session_id, target_id: row['id'] as number, range: contextRange,
                });
            }
            return entry;
        });
        ok(res, results);
    });

    app.get('/api/messages/latest', (_req, res) => {
        const includeContent = ['1', 'true', 'yes'].includes(String(_req.query["includeContent"] || '').toLowerCase());
        const latestRow = getLatestAssistantMessage.get(getActiveChatSession()) as {
            id?: number;
            role?: string;
            content?: string | null;
            created_at?: string;
        } | null;
        const activityRow = getLatestDashboardActivityMessage.get(getActiveChatSession()) as {
            id?: number;
            role?: string;
            excerpt?: string | null;
            created_at?: string;
        } | null;
        const title = dashboardActivityTitleFromExcerpt(activityRow?.excerpt || null);
        ok(res, {
            latestAssistant: latestRow?.id ? {
                id: Number(latestRow.id),
                role: 'assistant',
                ...(latestRow.created_at ? { created_at: String(latestRow.created_at) } : {}),
                ...(includeContent ? { text: String(latestRow.content || '') } : {}),
            } : null,
            activity: activityRow && title ? {
                messageId: Number(activityRow.id),
                role: String(activityRow.role || ''),
                title,
                updatedAt: String(activityRow.created_at || ''),
            } : null,
            processBusy: isAgentBusy(),
        });
    });
}
