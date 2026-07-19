// ─── Settings Merge Logic ────────────────────────────
// Phase 9.4 — server.js의 applySettingsPatch에서 추출한 deep merge 로직

// @strict-allow-any(loose JSON settings map boundary)
function cloneCliSettingsMap(value: unknown): Record<string, any> {
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value).map(([cli, cfg]) => [
        cli,
        cfg && typeof cfg === 'object' ? { ...cfg } : cfg,
    ]));
}

/**
 * settings 객체에 patch를 deep merge
 * perCli와 activeOverrides는 CLI별로 개별 merge (기존 effort/model 보존)
 * @param {object} current - 현재 settings
 * @param {object} patch - 적용할 패치
 * @returns {object} 새 settings (current를 직접 변경하지 않음)
 */
// @strict-allow-any(loose JSON settings patch boundary)
export function mergeSettingsPatch(current: Record<string, any>, patch: Record<string, any>) {
    const result = { ...current };
    const remaining = { ...patch };

    if (result["perCli"] && typeof result["perCli"] === 'object') {
        result["perCli"] = cloneCliSettingsMap(result["perCli"]);
    }
    if (result["activeOverrides"] && typeof result["activeOverrides"] === 'object') {
        result["activeOverrides"] = cloneCliSettingsMap(result["activeOverrides"]);
    }

    // Deep merge perCli at per-CLI level
    if (remaining["perCli"] && typeof remaining["perCli"] === 'object') {
        result["perCli"] = result["perCli"] || {};
        // @strict-allow-any(loose JSON perCli settings boundary)
        for (const [cli, cfg] of Object.entries(remaining["perCli"]) as [string, Record<string, any>][]) {
            result["perCli"][cli] = { ...result["perCli"][cli], ...cfg };
        }
        delete remaining["perCli"];
    }

    // Deep merge activeOverrides at per-CLI level
    if (remaining["activeOverrides"] && typeof remaining["activeOverrides"] === 'object') {
        result["activeOverrides"] = result["activeOverrides"] || {};
        // @strict-allow-any(loose JSON activeOverrides settings boundary)
        for (const [cli, cfg] of Object.entries(remaining["activeOverrides"]) as [string, Record<string, any>][]) {
            result["activeOverrides"][cli] = { ...result["activeOverrides"][cli], ...cfg };
        }
        delete remaining["activeOverrides"];
    }

    // Deep merge nested objects (heartbeat, telegram, telegramHub, memory, stt, jawCeo, pi, tui, network)
    for (const key of ['heartbeat', 'telegram', 'telegramHub', 'discord', 'memory', 'stt', 'jawCeo', 'pi', 'tui', 'messaging', 'network']) {
        if (remaining[key] && typeof remaining[key] === 'object') {
            if (key === 'network') {
                // @strict-allow-any(loose JSON record guard boundary)
                const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
                const networkPatch = remaining[key], currentRemoteAccess = isRecord(result[key]) ? result[key]["remoteAccess"] : undefined;
                const remoteAccessPatch = isRecord(networkPatch) ? networkPatch["remoteAccess"] : undefined;
                result[key] = { ...result[key], ...networkPatch };
                if (isRecord(remoteAccessPatch)) result[key]["remoteAccess"] =
                    { ...(isRecord(currentRemoteAccess) ? currentRemoteAccess : {}), ...remoteAccessPatch };
            } else result[key] = { ...result[key], ...remaining[key] };
            delete remaining[key];
        }
    }

    // Top-level scalar fields
    Object.assign(result, remaining);

    return result;
}
