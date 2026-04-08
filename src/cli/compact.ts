// ─── /compact Command Handler ───────────────────────

import {
    COMPACT_MARKER_CONTENT,
    buildManagedCompactSummaryForTest,
    getRowsSinceLatestCompactForTest,
} from '../core/compact.js';

function getActiveModel(settings: any, session: any, activeCli: string): string {
    const sessionCli = session?.active_cli || session?.activeCli;
    const sessionModel = session?.model && (!sessionCli || sessionCli === activeCli)
        ? session.model
        : undefined;
    return settings?.activeOverrides?.[activeCli]?.model
        || sessionModel
        || settings?.perCli?.[activeCli]?.model
        || 'default';
}

async function safeCall(fn: any, fallback: any = null) {
    if (typeof fn !== 'function') return fallback;
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

export async function compactHandler(args: string[], ctx: any) {
    const instructions = (args || []).join(' ').trim();
    const [settings, session, runtime] = await Promise.all([
        safeCall(ctx?.getSettings, null),
        safeCall(ctx?.getSession, null),
        safeCall(ctx?.getRuntime, null),
    ]);

    if (runtime?.activeAgent) {
        return {
            ok: false,
            code: 'compact_busy',
            text: 'Compact is available only when the main agent is idle.',
        };
    }

    const { isAgentBusy } = await import('../agent/spawn.js');
    if (isAgentBusy()) {
        return {
            ok: false,
            code: 'compact_busy',
            text: 'Compact is available only when the main agent is idle.',
        };
    }

    const activeCli = settings?.cli || session?.active_cli || session?.activeCli || 'claude';
    if (activeCli === 'claude' && session?.session_id) {
        const { spawnAgent } = await import('../agent/spawn.js');
        const prompt = instructions ? `/compact ${instructions}` : '/compact';
        const { promise } = spawnAgent(prompt, {
            cli: 'claude',
            origin: ctx?.interface || 'web',
            _skipInsert: true,
        });
        const result: any = await promise;
        if (result?.code === 0) {
            return {
                ok: true,
                code: 'compact_done',
                text: 'Conversation compacted.',
                meta: { path: 'claude-native' },
            };
        }
        return {
            ok: false,
            code: 'compact_failed',
            text: `Compact failed: ${String(result?.text || `exit ${result?.code ?? 1}`)}`.trim(),
        };
    }

    const { getRecentMessages, insertMessageWithTrace } = await import('../core/db.js');
    const { bumpSessionOwnershipGeneration } = await import('../agent/session-persistence.js');
    const { clearBossSessionOnly } = await import('../core/main-session.js');
    const recent = getRecentMessages.all(40) as any[];
    const compactionRows = getRowsSinceLatestCompactForTest(recent);
    if (!compactionRows.length) {
        return {
            ok: false,
            code: 'compact_unavailable',
            text: 'Compact failed: no conversation to compact.',
        };
    }

    const summary = buildManagedCompactSummaryForTest(recent, instructions);
    const model = getActiveModel(settings, session, activeCli);
    insertMessageWithTrace.run('assistant', COMPACT_MARKER_CONTENT, activeCli, model, summary, null);
    bumpSessionOwnershipGeneration();
    clearBossSessionOnly();
    return {
        ok: true,
        code: 'compact_done',
        text: 'Conversation compacted. Next turn will use compact summary.',
        meta: { path: 'managed', requiresNextTurn: true },
    };
}
