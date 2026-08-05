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
    activeOverrides?: Record<string, { model?: string; provider?: string }>;
    perCli?: Record<string, { model?: string; provider?: string }>;
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

    // Resolved before the harvest, not after: the marker below and the bootstrap built
    // here have to describe the same conversation, and the harvest reads it (073 §2.5a).
    const chatSessionId = getActiveChatSession();
    const slots = harvestBootstrapSlots({ workingDir, instructions, chatSessionId });
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

    const { insertMessageWithTrace, clearSessionBucket, clearSessionBucketsByPrefix } = await import('../core/db.js');
    const { aiEProviderForBucket, resolveSessionBucket } = await import('../agent/args.js');
    const {
        clearBossSessionOnly,
        setPendingBootstrapPrompt,
    } = await import('../core/main-session.js');

    const model = getActiveModel(settings, session, activeCli);
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
    const isCodexApp = activeCli === 'codex-app';
    // ai-e keys its bucket by provider, and a null here would make the bucket infer one
    // from the model name instead. When the configured provider and that inference
    // disagree, the clear lands on a bucket the conversation never used.
    const aiEProvider = aiEProviderForBucket(activeCli, model, settings);
    const base = resolveSessionBucket(activeCli, model, aiEProvider);
    // Always the scoped form, including the default scope. Letting default resolve to the
    // bare name looks harmless until the prefix clear below runs: `claude` plus `claude:%`
    // deletes every other session's bucket for this runtime. Default's own legacy bare row
    // is cleared separately, by exact key.
    const bucket = `${base}:${scope}`;
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

    // The prefix form covers codex-app, whose key folds in lane mode and effort that this
    // command cannot know. The scope is a whole segment of the pattern, so `claude:local:a`
    // plus `claude:local:a:%` cannot reach `claude:local:abc`. For every other runtime the
    // exact key is the only match, so the same call is correct without a branch.
    clearSessionBucketsByPrefix.run(bucket, `${bucket}:`);
    // The default scope also owns the bare legacy name, which is what a session created
    // before 073 resumes from. Clearing it by exact key keeps the neighbours out of it.
    if (isDefaultScope) clearSessionBucket.run(base);
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
