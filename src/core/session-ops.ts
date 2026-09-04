// ─── Session/settings lifecycle ops (web surface) ────
// Extracted from server.ts in Phase 2 (devlog 260609, 20 §3.1).
// Grouped here because all three bump the session ownership generation
// before mutating session or runtime-settings state.

import { bumpGenerationForSessionLocalReset, bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
import { resetFallbackState } from '../agent/spawn.js';
import { clearMainSessionState, resetSessionPreservingHistory } from './main-session.js';
import { applyRuntimeSettingsPatch } from './runtime-settings.js';
import { settings } from './config.js';
import { currentSessionScope } from './session-context.js';

/** Full reset: compact first, then delete message history. */
export async function clearSessionState(): Promise<void> {
    // The reset belongs to whichever session asked for it. Without passing the scope on,
    // the compact below falls back to the global ownership bump and the narrowing done at
    // the end of this function never matters — a reset in one tab still discards the turn
    // another tab has in flight (073 §2.2a).
    const sessionScope = currentSessionScope();
    const scopeKey = sessionScope?.scope;
    const chatSessionId = sessionScope?.chatSessionId;
    try {
        const { autoCompactRefresh } = await import('./compact.js');
        await autoCompactRefresh({
            workDir: settings["workingDir"] || null,
            instructions: '',
            cli: settings["cli"] || 'claude',
            model: settings["model"] || '',
            ...(scopeKey ? { scopeKey } : {}),
            ...(chatSessionId ? { chatSessionId } : {}),
        });
    } catch {} // best-effort: compact failure must not block session reset
    try {
        // Compact success already cleared the bucket, but repeat unconditionally:
        // an explicit reset must invalidate resumable native sessions (guarded AGY
        // resume reads session_buckets, not the main session row), even when
        // autoCompactRefresh() threw before reaching its own bucket clear.
        const { clearSessionBucket, clearSessionBucketsByPrefix } = await import('./db.js');
        const { aiEProviderForBucket, resolveSessionBucket } = await import('../agent/args.js');
        const cli = settings["cli"] || 'claude';
        const model = settings["model"] || '';
        // A reset with a session behind it belongs to that session even when the session
        // is the default one. Treating `default` as "no session" would let a reset of the
        // default chat clear the Slack and local scopes' lanes, which is the same
        // cross-session damage 073 exists to stop. Only an absent scope is instance-wide.
        const isInstanceWide = scopeKey === undefined;
        const scope = scopeKey ?? 'default';
        // ai-e keys its bucket by provider; without it the name is re-derived from the
        // model and a reset can clear a bucket the conversation never used.
        const base = resolveSessionBucket(cli, model, aiEProviderForBucket(cli, model, settings));
        if (isInstanceWide) {
            clearSessionBucketsByPrefix.run(base, 'codex-app:');
        } else {
            // Since 073 §2.1 every scope owns its bucket. The prefix form is needed
            // because codex-app folds lane mode and effort into its key and this path
            // knows neither, so an exact key built with those blank would match no row.
            // The scope has to be a whole segment of the pattern: `codex-app:local:a%`
            // would also delete `local:abc`, a different session's rows.
            const scoped = `${base}:${scope}`;
            clearSessionBucketsByPrefix.run(scoped, `${scoped}:`);
            // The default scope also owns the bare legacy name, which is what a session
            // created before 073 has been resuming from all along.
            if (scope === 'default') clearSessionBucket.run(base);
        }
        // The stored rows are half of it: an idle lane holds its thread in memory and,
        // with nothing left to contradict it, the next turn resumes the conversation this
        // reset just discarded.
        try {
            const { invalidateCodexAppLanesForScope } = await import('../agent/codex-host-pool.js');
            invalidateCodexAppLanesForScope(isInstanceWide ? null : scope);
        } catch (e) {
            console.warn('[jaw:reset] lane invalidation failed:', (e as Error).message);
        }
    } catch (e) {
        console.warn('[jaw:reset] session bucket clear failed:', (e as Error).message);
    }
    bumpGenerationForSessionLocalReset();
    clearMainSessionState();
}

/** Soft reset: new session, history preserved. */
export function resetSessionOnly(): void {
    bumpGenerationForSessionLocalReset();
    resetSessionPreservingHistory();
}

/** Drop the resumable vendor session for the current scope, keeping history.
 *
 *  `/new` used to switch the chat session and stop there. The vendor session
 *  bucket survived, so the runtime resumed the very conversation the user had
 *  just asked to leave — and because a resumable session still existed, the
 *  Slack prefetch latch also concluded there was nothing to re-inject and the
 *  thread's history was never handed back (#518).
 *
 *  This is the bucket half of `clearSessionState` without the history deletion,
 *  which is the whole difference between `/new` and `/clear`. */
export async function clearResumableSessionForScope(): Promise<void> {
    try {
        const { clearSessionBucket, clearSessionBucketsByPrefix } = await import('./db.js');
        const { aiEProviderForBucket, resolveSessionBucket } = await import('../agent/args.js');
        const cli = settings["cli"] || 'claude';
        const model = settings["model"] || '';
        const scope = currentSessionScope()?.scope ?? 'default';
        const base = resolveSessionBucket(cli, model, aiEProviderForBucket(cli, model, settings));
        // Same prefix pair `clearSessionState` uses: codex-app folds lane mode and
        // effort into its key, so an exact name built with those blank matches nothing.
        const scoped = `${base}:${scope}`;
        clearSessionBucketsByPrefix.run(scoped, `${scoped}:`);
        if (scope === 'default') clearSessionBucket.run(base);
        try {
            const { invalidateCodexAppLanesForScope } = await import('../agent/codex-host-pool.js');
            invalidateCodexAppLanesForScope(scope);
        } catch (e) {
            console.warn('[jaw:new] lane invalidation failed:', (e as Error).message);
        }
    } catch (e) {
        console.warn('[jaw:new] session bucket clear failed:', (e as Error).message);
    }
}

export async function applySettingsPatch(rawPatch: Record<string, unknown> = {}) {
    bumpSessionOwnershipGeneration();
    return applyRuntimeSettingsPatch(rawPatch, {
        resetFallbackState: () => resetFallbackState(null),
    });
}
