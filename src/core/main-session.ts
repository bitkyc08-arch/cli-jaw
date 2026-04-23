import { broadcast } from './bus.js';
import { settings } from './config.js';
import { db, clearMessages, clearMessagesScoped, getSession, updateSession } from './db.js';

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
    const ao = currentSettings.activeOverrides?.[cli] || {};
    const pc = currentSettings.perCli?.[cli] || {};
    return {
        model: ao.model || pc.model || 'default',
        effort: ao.effort || pc.effort || 'medium',
    };
}

export function resolveMainCli(
    requestedCli?: string | null,
    currentSettings: Record<string, any> = settings,
    session: MainSessionRecord | null = null,
): string {
    return requestedCli
        || currentSettings.cli
        || session?.active_cli
        || 'claude';
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
        permissions: currentSettings.permissions || 'auto',
        workingDir: currentSettings.workingDir || '~',
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
        permissions: currentSettings.permissions || 'auto',
        workingDir: currentSettings.workingDir || '~',
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
        console.log(`[jaw:session] invalidated — CLI changed ${prevCli} → ${row.cli}`);
    }
    writeMainSessionRow(row);
    return row;
}

// Atomic: delete messages + update session in one transaction
const clearMainTx = db.transaction((row: MainSessionRow) => {
    if (row.workingDir && row.workingDir !== '~') {
        clearMessagesScoped.run(row.workingDir);
    } else {
        clearMessages.run();
    }
    writeMainSessionRow(row);
});

export function clearMainSessionState(): MainSessionRow {
    const session = getSession() as MainSessionRecord;
    const row = buildClearedSessionRow(settings, session);
    clearMainTx(row);
    broadcast('clear', {});
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
    broadcast('session_reset', { cli: row.cli, model: row.model });
    return row;
}

// ─── Pending bootstrap prompt (1-shot consumption, DB-backed) ───
// Phase 52: persist to DB so a server crash between compact and consumption
// no longer drops the bootstrap text. Stored in `memory` table with a reserved
// key + source so the user-facing memory list filters it out.
//
// Compact handler stores here; next spawnAgent() prepends and clears.

import { getMemory, upsertMemory, deleteMemory } from './db.js';

const BOOTSTRAP_KEY = '__bootstrap_prompt';
const BOOTSTRAP_SOURCE = '__system_bootstrap';

function readBootstrapRow(): string | null {
    try {
        const rows = getMemory.all() as Array<{ key: string; value: string; source: string }>;
        const row = rows.find(r => r.key === BOOTSTRAP_KEY && r.source === BOOTSTRAP_SOURCE);
        return row?.value && row.value.trim() ? row.value : null;
    } catch (e) {
        console.warn('[jaw:bootstrap] readBootstrapRow failed:', (e as Error).message);
        return null;
    }
}

export function setPendingBootstrapPrompt(text: string | null): void {
    try {
        if (text && text.trim()) {
            upsertMemory.run(BOOTSTRAP_KEY, text, BOOTSTRAP_SOURCE);
        } else {
            deleteMemory.run(BOOTSTRAP_KEY);
        }
    } catch (e) {
        console.warn('[jaw:bootstrap] setPendingBootstrapPrompt failed:', (e as Error).message);
    }
}

export function consumePendingBootstrapPrompt(): string | null {
    const out = readBootstrapRow();
    if (out) {
        try { deleteMemory.run(BOOTSTRAP_KEY); }
        catch (e) { console.warn('[jaw:bootstrap] consume delete failed:', (e as Error).message); }
    }
    return out;
}

export function peekPendingBootstrapPrompt(): string | null {
    return readBootstrapRow();
}
