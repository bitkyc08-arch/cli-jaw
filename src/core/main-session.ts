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

// ─── Pending bootstrap prompt (1-shot consumption) ───
// Compact handler stores here; next spawnAgent() prepends and clears.

let pendingBootstrapPrompt: string | null = null;

export function setPendingBootstrapPrompt(text: string | null): void {
    pendingBootstrapPrompt = text && text.trim() ? text : null;
}

export function consumePendingBootstrapPrompt(): string | null {
    const out = pendingBootstrapPrompt;
    pendingBootstrapPrompt = null;
    return out;
}

export function peekPendingBootstrapPrompt(): string | null {
    return pendingBootstrapPrompt;
}
