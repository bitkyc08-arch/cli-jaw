import { broadcast } from './bus.js';
import { settings } from './config.js';
import { clearMessages, getSession, updateSession } from './db.js';

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

export function clearMainSessionState(): MainSessionRow {
    clearMessages.run();
    const session = getSession() as MainSessionRecord;
    const row = buildClearedSessionRow(settings, session);
    writeMainSessionRow(row);
    broadcast('clear', {});
    return row;
}
