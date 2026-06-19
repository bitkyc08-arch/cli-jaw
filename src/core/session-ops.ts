// ─── Session/settings lifecycle ops (web surface) ────
// Extracted from server.ts in Phase 2 (devlog 260609, 20 §3.1).
// Grouped here because all three bump the session ownership generation
// before mutating session or runtime-settings state.

import { bumpSessionOwnershipGeneration } from '../agent/session-persistence.js';
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
    } catch {}
    bumpSessionOwnershipGeneration();
    clearMainSessionState();
}

/** Soft reset: new session, history preserved. */
export function resetSessionOnly(): void {
    bumpSessionOwnershipGeneration();
    resetSessionPreservingHistory();
}

export async function applySettingsPatch(rawPatch: Record<string, unknown> = {}) {
    bumpSessionOwnershipGeneration();
    return applyRuntimeSettingsPatch(rawPatch, {
        resetFallbackState,
    });
}
