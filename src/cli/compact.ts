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
import { getActiveChatSession } from '../core/chat-sessions.js';
import type { CliCommandContext } from './command-context.js';
import type { SlashResult } from './types.js';

interface CompactSettings {
    cli?: string;
    workingDir?: string | null;
    activeOverrides?: Record<string, { model?: string }>;
    perCli?: Record<string, { model?: string }>;
    multiSession?: { enabled?: boolean };
}
interface CompactSession {
    active_cli?: string;
    activeCli?: string;
    model?: string;
}

function getActiveModel(settings: CompactSettings | null, session: CompactSession | null, activeCli: string): string {
    const sessionCli = session?.active_cli || session?.activeCli;
    const sessionModel = session?.model && (!sessionCli || sessionCli === activeCli)
        ? session.model
        : undefined;
    return settings?.activeOverrides?.[activeCli]?.model
        || sessionModel
        || settings?.perCli?.[activeCli]?.model
        || 'default';
}

async function safeCall<T>(
    fn: (() => Promise<T> | T) | undefined | null,
    fallback: T | null = null,
): Promise<T | null> {
    if (typeof fn !== 'function') return fallback;
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

export async function compactHandler(args: string[], ctx: CliCommandContext): Promise<SlashResult> {
    const instructions = (args || []).join(' ').trim();
    const [settings, session, runtime] = await Promise.all([
        safeCall(ctx?.getSettings, null),
        safeCall(ctx?.getSession, null),
        safeCall(ctx?.getRuntime, null),
    ]) as [CompactSettings | null, CompactSession | null, { activeAgent?: boolean } | null];

    if (runtime?.activeAgent) {
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
        || slots.tool_context
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

    const { insertMessageWithTrace, clearSessionBucketsByPrefix } = await import('../core/db.js');
    const { resolveSessionBucket } = await import('../agent/args.js');
    const {
        bumpSessionOwnershipGeneration,
    } = await import('../agent/session-persistence.js');
    const {
        clearBossSessionOnly,
        setPendingBootstrapPrompt,
    } = await import('../core/main-session.js');

    const model = getActiveModel(settings, session, activeCli);
    const chatSessionId = getActiveChatSession();
    const { scopeForChatSession, isNativeStateIsolatedScope } = await import('../orchestrator/scope.js');
    const { getChatSessionRemoteKey } = await import('../core/chat-sessions.js');
    const scope = scopeForChatSession(
        chatSessionId,
        getChatSessionRemoteKey(chatSessionId) ?? undefined,
        settings?.multiSession?.enabled === true,
    );
    // The marker and bootstrap below go to the session the user is compacting. Clearing
    // the shared bucket and singleton row would land on the DEFAULT session instead,
    // discarding a conversation another tab is still using while the user believes they
    // reset their own (072 §1.2b). A scope with no native state has nothing to clear.
    const nativeStateIsolated = isNativeStateIsolatedScope(scope);
    const bucket = nativeStateIsolated ? '' : resolveSessionBucket(activeCli, model);
    insertMessageWithTrace.run(
        'assistant',
        COMPACT_MARKER_CONTENT,
        activeCli,
        model,
        trace,
        null,
        workingDir,
        chatSessionId,
    );
    setPendingBootstrapPrompt(bootstrap, nativeStateIsolated ? scope : undefined);
    if (nativeStateIsolated) {
        const { bumpScopeSessionGeneration } = await import('../agent/session-persistence.js');
        bumpScopeSessionGeneration(scope);
    } else {
        bumpSessionOwnershipGeneration();
        clearBossSessionOnly();
        // An explicit compact resets the conversation the user is looking at, and it
        // cannot know which scope or effort produced the scoped rows, so it drops all
        // of them alongside the legacy row. Leaving one behind would let the next
        // multiplex run resume the thread the user just discarded.
        clearSessionBucketsByPrefix.run(bucket, 'codex-app:%');
    }

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
                tool_context_len: slots.tool_context.length,
                memory_hits_len: slots.memory_hits.length,
                grep_hits_len: slots.grep_hits.length,
                task_snapshot_len: slots.task_snapshot.length,
                total_len: bootstrap.length,
            },
        },
    };
}
