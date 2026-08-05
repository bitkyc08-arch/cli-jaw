import { broadcast } from './bus.js';
import { DEFAULT_CLI } from '../cli/registry.js';
import { settings } from './config.js';
import { db, clearMessages, clearMessagesScoped, getSession, updateSession } from './db.js';
import { getActiveChatSession, getChatSessionRemoteKey } from './chat-sessions.js';
import { scopeForChatSession } from '../orchestrator/scope.js';

export type MainSessionRecord = {
    active_cli?: string | null;
    session_id?: string | null;
    model?: string | null;
    permissions?: string | null;
    working_dir?: string | null;
    effort?: string | null;
};

export type MainSessionRow = {
    cli: string;
    sessionId: string | null;
    model: string;
    permissions: string;
    workingDir: string;
    effort: string;
};

export function getCliModelAndEffort(
    cli: string,
    currentSettings: Record<string, any> = settings,
): { model: string; effort: string } {
    const ao = currentSettings["activeOverrides"]?.[cli] || {};
    const pc = currentSettings["perCli"]?.[cli] || {};
    return {
        model: ao.model || pc.model || 'default',
        effort: ao.effort ?? pc.effort ?? 'medium',
    };
}

export function resolveMainCli(
    requestedCli?: string | null,
    currentSettings: Record<string, any> = settings,
    session: MainSessionRecord | null = null,
): string {
    return requestedCli
        || currentSettings["cli"]
        || session?.active_cli
        || DEFAULT_CLI;
}

export function buildSelectedSessionRow(
    currentSettings: Record<string, any> = settings,
    session: MainSessionRecord | null = null,
    prevCli: string | null = null,
): MainSessionRow {
    const cli = resolveMainCli(null, currentSettings, session);
    const { model, effort } = getCliModelAndEffort(cli, currentSettings);
    const sessionId = prevCli && cli !== prevCli ? null : (session?.session_id || null);
    return {
        cli,
        sessionId,
        model,
        permissions: currentSettings["permissions"] || 'auto',
        workingDir: currentSettings["workingDir"] || '~',
        effort,
    };
}

export function buildClearedSessionRow(
    currentSettings: Record<string, any> = settings,
    session: MainSessionRecord | null = null,
): MainSessionRow {
    const cli = resolveMainCli(null, currentSettings, session);
    const { model, effort } = getCliModelAndEffort(cli, currentSettings);
    return {
        cli,
        sessionId: null,
        model,
        permissions: currentSettings["permissions"] || 'auto',
        workingDir: currentSettings["workingDir"] || '~',
        effort,
    };
}

export function writeMainSessionRow(row: MainSessionRow): void {
    updateSession.run(row.cli, row.sessionId, row.model, row.permissions, row.workingDir, row.effort);
}

export function syncMainSessionToSettings(prevCli: string | null = null): MainSessionRow {
    const session = getSession() as MainSessionRecord;
    const row = buildSelectedSessionRow(settings, session, prevCli);
    if (prevCli && row.cli !== prevCli && session?.session_id) {
        log.info(`[jaw:session] invalidated — CLI changed ${prevCli} → ${row.cli}`);
    }
    writeMainSessionRow(row);
    return row;
}

// Atomic: delete messages + update session in one transaction
const clearMainTx = db.transaction((row: MainSessionRow) => {
    if (row.workingDir && row.workingDir !== '~') {
        clearMessagesScoped.run(row.workingDir, getActiveChatSession());
    } else {
        clearMessages.run(getActiveChatSession());
    }
    writeMainSessionRow(row);
});

export function clearMainSessionState(): MainSessionRow {
    const session = getSession() as MainSessionRecord;
    const row = buildClearedSessionRow(settings, session);
    // Capture the session BEFORE the transaction so the notice names exactly the history
    // that was deleted. Without a scope on it, a scoped tab drops the event and keeps
    // showing messages that no longer exist — including the tab whose history this was.
    const clearedSessionId = getActiveChatSession();
    clearMainTx(row);
    broadcast('clear', {
        scope: scopeForChatSession(clearedSessionId, getChatSessionRemoteKey(clearedSessionId) ?? undefined),
        sessionId: clearedSessionId,
    });
    return row;
}

/** Reset boss session ID (prevents stale --resume) but preserves message history. */
export function clearBossSessionOnly(): MainSessionRow {
    const session = getSession() as MainSessionRecord;
    const row = buildClearedSessionRow(settings, session);
    writeMainSessionRow(row);
    return row;
}

/** Reset session for /reset confirm — clears session ID but preserves messages and notifies frontend. */
export function resetSessionPreservingHistory(): MainSessionRow {
    const session = getSession() as MainSessionRecord;
    const row = buildClearedSessionRow(settings, session);
    writeMainSessionRow(row);
    const resetSessionId = getActiveChatSession();
    broadcast('session_reset', {
        cli: row.cli,
        model: row.model,
        scope: scopeForChatSession(resetSessionId, getChatSessionRemoteKey(resetSessionId) ?? undefined),
        sessionId: resetSessionId,
    });
    return row;
}

// ─── Pending bootstrap prompt (1-shot consumption, DB-backed) ───
// Phase 52: persist to DB so a server crash between compact and consumption
// no longer drops the bootstrap text. Stored in `memory` table with a reserved
// key + source so the user-facing memory list filters it out.
//
// Compact handler stores here; next spawnAgent() prepends and clears.

import { getMemory, upsertMemory, deleteMemory } from './db.js';
import { log } from './logger.js';

const BOOTSTRAP_KEY = '__bootstrap_prompt';
const BOOTSTRAP_SOURCE = '__system_bootstrap';

// A compact summary belongs to the conversation that produced it. While one main
// run existed at a time a single row was enough; with several scopes in flight the
// first spawn to look would take someone else's handoff. Scoped rows get their own
// key and the bare key stays the default scope's, which is what existing rows are.
function bootstrapKeyFor(scopeKey?: string | null): string {
    return !scopeKey || scopeKey === 'default' ? BOOTSTRAP_KEY : `${BOOTSTRAP_KEY}:${scopeKey}`;
}

function readBootstrapRow(scopeKey?: string | null): string | null {
    try {
        const key = bootstrapKeyFor(scopeKey);
        const rows = getMemory.all() as Array<{ key: string; value: string; source: string }>;
        const row = rows.find(r => r.key === key && r.source === BOOTSTRAP_SOURCE);
        return row?.value && row.value.trim() ? row.value : null;
    } catch (e) {
        console.warn('[jaw:bootstrap] readBootstrapRow failed:', (e as Error).message);
        return null;
    }
}

export function setPendingBootstrapPrompt(text: string | null, scopeKey?: string | null): void {
    try {
        const key = bootstrapKeyFor(scopeKey);
        if (text && text.trim()) {
            upsertMemory.run(key, text, BOOTSTRAP_SOURCE);
        } else {
            deleteMemory.run(key);
        }
    } catch (e) {
        console.warn('[jaw:bootstrap] setPendingBootstrapPrompt failed:', (e as Error).message);
    }
}

// Strict variant: throws on DB failure. Use inside transactions where the caller
// must know about persistence loss so the surrounding tx can roll back.
export function setPendingBootstrapPromptStrict(text: string | null, scopeKey?: string | null): void {
    const key = bootstrapKeyFor(scopeKey);
    if (text && text.trim()) {
        upsertMemory.run(key, text, BOOTSTRAP_SOURCE);
    } else {
        deleteMemory.run(key);
    }
}

export function consumePendingBootstrapPrompt(scopeKey?: string | null): string | null {
    const out = readBootstrapRow(scopeKey);
    if (out) {
        try { deleteMemory.run(bootstrapKeyFor(scopeKey)); }
        catch (e) { console.warn('[jaw:bootstrap] consume delete failed:', (e as Error).message); }
    }
    return out;
}

export function peekPendingBootstrapPrompt(scopeKey?: string | null): string | null {
    return readBootstrapRow(scopeKey);
}
