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
    const scopeKey = currentSessionScope()?.scope;
    try {
        const { autoCompactRefresh } = await import('./compact.js');
        await autoCompactRefresh({
            workDir: settings["workingDir"] || null,
            instructions: '',
            cli: settings["cli"] || 'claude',
            model: settings["model"] || '',
            ...(scopeKey ? { scopeKey } : {}),
        });
    } catch {} // best-effort: compact failure must not block session reset
    try {
        // Compact success already cleared the bucket, but repeat unconditionally:
        // an explicit reset must invalidate resumable native sessions (guarded AGY
        // resume reads session_buckets, not the main session row), even when
        // autoCompactRefresh() threw before reaching its own bucket clear.
        const { clearSessionBucket, clearSessionBucketsByPrefix } = await import('./db.js');
        const { resolveScopedSessionBucket } = await import('../agent/args.js');
        const cli = settings["cli"] || 'claude';
        const model = settings["model"] || '';
        const codexAppMultiplex = settings["runtime"]?.codexApp?.multiplex === true;
        const bucket = resolveScopedSessionBucket(
            cli, model, null, scopeKey || 'default', '', 'fallback', codexAppMultiplex,
        );
        // Since 073 §2.1 every scope owns its bucket, so a reset clears its own. Only a
        // reset with no session behind it is an instance-wide one, and only that may take
        // the codex-app lane rows with it — those are keyed by scope, and wiping them all
        // would cut lanes belonging to sessions that never asked for a reset.
        if (scopeKey && scopeKey !== 'default') clearSessionBucket.run(bucket);
        else clearSessionBucketsByPrefix.run(bucket, 'codex-app:%');
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

export async function applySettingsPatch(rawPatch: Record<string, unknown> = {}) {
    bumpSessionOwnershipGeneration();
    return applyRuntimeSettingsPatch(rawPatch, {
        resetFallbackState: () => resetFallbackState(null),
    });
}
