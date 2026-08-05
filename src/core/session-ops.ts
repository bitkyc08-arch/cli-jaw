// ─── Session/settings lifecycle ops (web surface) ────
// Extracted from server.ts in Phase 2 (devlog 260609, 20 §3.1).
// Grouped here because all three bump the session ownership generation
// before mutating session or runtime-settings state.

import { bumpGenerationForSessionLocalReset, bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
import { resetFallbackState } from '../agent/spawn.js';
import { clearMainSessionState, resetSessionPreservingHistory } from './main-session.js';
import { applyRuntimeSettingsPatch } from './runtime-settings.js';
import { settings } from './config.js';

/** Full reset: compact first, then delete message history. */
export async function clearSessionState(): Promise<void> {
    try {
        const { autoCompactRefresh } = await import('./compact.js');
        await autoCompactRefresh({
            workDir: settings["workingDir"] || null,
            instructions: '',
            cli: settings["cli"] || 'claude',
            model: settings["model"] || '',
        });
    } catch {} // best-effort: compact failure must not block session reset
    try {
        // Compact success already cleared the bucket, but repeat unconditionally:
        // an explicit reset must invalidate resumable native sessions (guarded AGY
        // resume reads session_buckets, not the main session row), even when
        // autoCompactRefresh() threw before reaching its own bucket clear.
        const { clearSessionBucketsByPrefix } = await import('./db.js');
        const { resolveSessionBucket } = await import('../agent/args.js');
        const bucket = resolveSessionBucket(settings["cli"] || 'claude', settings["model"] || '');
        clearSessionBucketsByPrefix.run(bucket, 'codex-app:%');
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
