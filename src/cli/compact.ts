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
    runtime?: { codexApp?: { multiplex?: boolean } };
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
    const { resolveScopedSessionBucket, resolveSessionBucket } = await import('../agent/args.js');
    const {
        clearBossSessionOnly,
        setPendingBootstrapPrompt,
    } = await import('../core/main-session.js');

    const model = getActiveModel(settings, session, activeCli);
    const chatSessionId = getActiveChatSession();
    const { scopeForChatSession } = await import('../orchestrator/scope.js');
    const { getChatSessionRemoteKey } = await import('../core/chat-sessions.js');
    const scope = scopeForChatSession(
        chatSessionId,
        getChatSessionRemoteKey(chatSessionId) ?? undefined,
        settings?.multiSession?.enabled === true,
    );
    // Every runtime now keys its bucket by scope (073 §2.1), so this compacts the session
    // it was typed into rather than refusing to touch anything. Its marker, its bootstrap
    // and the state it drops all belong to the same session, which is what 072 could not
    // arrange when a non-default scope had no bucket of its own.
    //
    // The exact codex-app key folds in lane mode and effort, which this command cannot
    // know, so it clears that runtime by scope prefix instead of rebuilding the key.
    const isCodexApp = activeCli === 'codex-app';
    // This command knows the scope but not the effort, and codex-app folds effort into
    // its multiplex key. Rather than build a key with a hole in it, clear by the prefix
    // that identifies the scope: base for every runtime, base plus scope for codex-app.
    const multiplex = settings?.runtime?.codexApp?.multiplex === true;
    const base = resolveSessionBucket(activeCli, model);
    const bucket = isCodexApp && multiplex
        ? `${base}:${scope}`
        : resolveScopedSessionBucket(activeCli, model, null, scope, '', 'fallback', false);
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
    const isDefaultScope = scope === 'default';
    // The bootstrap is keyed by scope so the next turn of THIS session picks it up and
    // no other session does. The default scope keeps the bare key it always had.
    setPendingBootstrapPrompt(bootstrap, isDefaultScope ? undefined : scope);

    // Only this session's generation moves. Bumping the global one would make every
    // other session's in-flight turn fail its ownership check and discard the vendor
    // conversation it had just created (073 §2e).
    const { bumpScopeSessionGeneration } = await import('../agent/session-persistence.js');
    bumpScopeSessionGeneration(scope);
    if (isDefaultScope) {
        // The singleton row belongs to the default session, so only its own compact
        // clears it.
        clearBossSessionOnly();
    }

    // codex-app folds lane mode and effort into its key, which this command cannot know,
    // so it clears that runtime by prefix. Every other runtime has one key per scope.
    // The prefix form covers codex-app, whose key folds in lane mode and effort that this
    // command cannot know. For every other runtime the exact key is the only match, so the
    // same call is correct without a branch.
    clearSessionBucketsByPrefix.run(bucket, `${bucket}:%`);
    if (isCodexApp) {
        // The rows are half of it: an idle lane keeps its thread in memory and, with no
        // stored thread left to contradict it, the next turn would reuse the very
        // conversation this compact discarded.
        const { invalidateCodexAppLanesForScope } = await import('../agent/codex-host-pool.js');
        invalidateCodexAppLanesForScope(scope);
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
