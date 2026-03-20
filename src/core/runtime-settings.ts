import {
    loadUnifiedMcp, syncToAll,
    ensureWorkingDirSkillsLinks, initMcpConfig,
} from '../../lib/mcp-sync.js';
import { syncCodexContextWindow } from './codex-config.js';
import { settings, replaceSettings, saveSettings } from './config.js';
import { syncMainSessionToSettings } from './main-session.js';
import { mergeSettingsPatch } from './settings-merge.js';
import { regenerateB } from '../prompt/builder.js';

type ApplyRuntimeSettingsOptions = {
    resetFallbackState?: () => void;
    restartTelegram?: boolean;
    onRestartTelegram?: (() => void) | null;
};

export function applyRuntimeSettingsPatch(
    rawPatch: Record<string, any> = {},
    opts: ApplyRuntimeSettingsOptions = {},
) {
    const prevCli = settings.cli;
    const prevWorkingDir = settings.workingDir;
    const hasTelegramUpdate = !!(rawPatch || {}).telegram || !!(rawPatch || {}).discord
        || !!(rawPatch || {}).channel || (rawPatch || {}).locale !== undefined;

    const merged = mergeSettingsPatch(settings, rawPatch);
    replaceSettings(merged);
    saveSettings(settings);

    if (rawPatch.perCli?.codex && 'contextWindow' in rawPatch.perCli.codex) {
        const codexCfg = settings.perCli?.codex || {};
        syncCodexContextWindow({
            enabled: !!codexCfg.contextWindow,
            contextWindow: codexCfg.contextWindowSize || 1000000,
            compactLimit: codexCfg.contextCompactLimit || 900000,
        });
    }

    opts.resetFallbackState?.();
    syncMainSessionToSettings(prevCli);

    if (settings.workingDir !== prevWorkingDir) {
        try {
            initMcpConfig(settings.workingDir);
            ensureWorkingDirSkillsLinks(settings.workingDir, { onConflict: 'skip', includeClaude: true, allowReplaceManaged: true });
            syncToAll(loadUnifiedMcp());
            regenerateB();
            console.log(`[jaw:workingDir] artifacts regenerated for ${settings.workingDir}`);
        } catch (e: unknown) {
            console.error('[jaw:workingDir]', (e as Error).message);
        }
    }

    if (opts.restartTelegram && hasTelegramUpdate) {
        opts.onRestartTelegram?.();
    }

    return settings;
}
