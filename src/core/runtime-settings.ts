import {
    loadUnifiedMcp, syncToAll,
    ensureWorkingDirSkillsLinks, initMcpConfig,
} from '../../lib/mcp-sync.js';
import { syncCodexContextWindow } from './codex-config.js';
import { settings, replaceSettings, saveSettings, migrateSettings } from './config.js';
import { syncMainSessionToSettings } from './main-session.js';
import { mergeSettingsPatch } from './settings-merge.js';
import { regenerateB } from '../prompt/builder.js';
import { restartMessagingRuntime, initActiveMessagingRuntime } from '../messaging/runtime.js';
import { beginRuntimeSettingsMutation } from './runtime-settings-gate.js';

type ApplyRuntimeSettingsOptions = {
    resetFallbackState?: () => void;
};

export async function applyRuntimeSettingsPatch(
    rawPatch: Record<string, any> = {},
    opts: ApplyRuntimeSettingsOptions = {},
): Promise<Record<string, any>> {
    const finishSettingsMutation = beginRuntimeSettingsMutation();
    const prevCli = settings.cli;
    const prevWorkingDir = settings.workingDir;
    const prevSnapshot = { ...settings };

    try {
        const merged = mergeSettingsPatch(settings, rawPatch);
        const migrated = migrateSettings(merged);
        replaceSettings(migrated);
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

        // CLI-changed branch delegates main-session clearing to cliSwitchRefresh
        // (which writes a cleared row inside its DB transaction). On refresh failure
        // we revert settings; the original session row is preserved because nothing
        // touched it on this branch (no syncMainSessionToSettings call).
        const cliChanged = !!(prevCli && settings.cli && prevCli !== settings.cli);
        if (cliChanged) {
            const toCli = settings.cli;
            const toModel = settings.activeOverrides?.[toCli]?.model
                || settings.perCli?.[toCli]?.model
                || 'default';
            try {
                const { cliSwitchRefresh } = await import('./compact.js');
                await cliSwitchRefresh({
                    sourceWorkDir: prevWorkingDir || '',
                    targetWorkDir: settings.workingDir || '',
                    fromCli: prevCli,
                    toCli,
                    toModel,
                });
            } catch (e: unknown) {
                console.error('[runtime-settings] cli switch refresh failed, rolling back:', (e as Error).message);
                replaceSettings(prevSnapshot);
                saveSettings(prevSnapshot);
                throw e;
            }
        } else {
            syncMainSessionToSettings(prevCli);
        }

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

        // Unified messaging runtime restart (handles both Telegram and Discord)
        try {
            await restartMessagingRuntime(prevSnapshot, settings, rawPatch);
        } catch (e: unknown) {
            // Rollback: restore previous settings AND attempt to re-init previous runtime
            console.error('[runtime-settings] restart failed, rolling back:', (e as Error).message);
            replaceSettings(prevSnapshot);
            saveSettings(prevSnapshot);
            try {
                await initActiveMessagingRuntime();
            } catch (reInitErr: unknown) {
                console.error('[runtime-settings] rollback re-init also failed:', (reInitErr as Error).message);
            }
            throw e;
        }

        return settings;
    } finally {
        finishSettingsMutation();
    }
}
