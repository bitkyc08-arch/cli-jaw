// ─── /compact Command Handler (bootstrap model) ──────
// Vendor-agnostic: resets session ID, harvests 5 slots, stores bootstrap
// in pending field; next spawnAgent() prepends bootstrap 1-shot to user input.

import {
    COMPACT_MARKER_CONTENT,
    BOOTSTRAP_TRACE_PREFIX,
    harvestBootstrapSlots,
    renderBootstrapPrompt,
    normalizeWorkingDir,
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
    const workingDir = normalizeWorkingDir(settings?.workingDir || null);

    const slots = harvestBootstrapSlots({ workingDir, instructions });
    const hasAnyContent = Boolean(
        slots.recent_turns
        || slots.memory_hits
        || slots.grep_hits
        || slots.task_snapshot,
    );
    if (!hasAnyContent) {
        return {
            ok: false,
            code: 'compact_unavailable',
            text: 'Compact failed: no conversation or memory to compact.',
        };
    }

    const bootstrap = renderBootstrapPrompt(slots);
    const trace = `${BOOTSTRAP_TRACE_PREFIX}\n${bootstrap}`;

    const { insertMessageWithTrace } = await import('../core/db.js');
    const {
        bumpSessionOwnershipGeneration,
    } = await import('../agent/session-persistence.js');
    const {
        clearBossSessionOnly,
        setPendingBootstrapPrompt,
    } = await import('../core/main-session.js');

    const model = getActiveModel(settings, session, activeCli);
    insertMessageWithTrace.run(
        'assistant',
        COMPACT_MARKER_CONTENT,
        activeCli,
        model,
        trace,
        null,
        workingDir,
    );
    setPendingBootstrapPrompt(bootstrap);
    bumpSessionOwnershipGeneration();
    clearBossSessionOnly();

    return {
        ok: true,
        code: 'compact_done',
        text: 'Conversation compacted. Next message will continue with a fresh session using the summary above.',
        meta: {
            path: 'bootstrap',
            requiresNextTurn: true,
            slots: {
                goal_len: slots.goal.length,
                recent_turns_len: slots.recent_turns.length,
                memory_hits_len: slots.memory_hits.length,
                grep_hits_len: slots.grep_hits.length,
                task_snapshot_len: slots.task_snapshot.length,
                total_len: bootstrap.length,
            },
        },
    };
}
