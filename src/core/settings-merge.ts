// ─── Settings Merge Logic ────────────────────────────
// Phase 9.4 — server.js의 applySettingsPatch에서 추출한 deep merge 로직

export type SettingsInputSource = 'boot' | 'watch' | 'api';
export type SettingsPersistenceShape = 'absent' | 'present';

export type SanitizedSettingsInput = {
    value: Record<string, any>;
    persistenceShape: SettingsPersistenceShape;
    serverOwnedPaths: string[];
    invalidPaths: string[];
    rejectedPaths: string[];
};

function isPlainRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Apply the shared nested settings policy at every untrusted ingress.
 * Boot/watch consume full documents, so an absent or invalid gate becomes the
 * execution default false while persistence shape remains absent. API input is
 * a patch, so a missing gate must not overwrite the current runtime value.
 */
export function sanitizeSettingsInput(
    input: Record<string, any>,
    source: SettingsInputSource,
): SanitizedSettingsInput {
    const value = { ...input };
    const serverOwnedPaths: string[] = [];
    const invalidPaths: string[] = [];
    const rejectedPaths: string[] = [];
    let persistenceShape: SettingsPersistenceShape = 'absent';

    const runtimeInput = isPlainRecord(input["runtime"]) ? input["runtime"] : null;
    const codexAppInput = runtimeInput && isPlainRecord(runtimeInput["codexApp"])
        ? runtimeInput["codexApp"]
        : null;
    const runtime = runtimeInput ? { ...runtimeInput } : {};
    const codexApp = codexAppInput ? { ...codexAppInput } : {};

    if (codexAppInput && Object.prototype.hasOwnProperty.call(codexAppInput, 'laneMode')) {
        const path = 'runtime.codexApp.laneMode';
        delete codexApp["laneMode"];
        rejectedPaths.push(path);
        if (source === 'api') serverOwnedPaths.push(path);
    }

    if (codexAppInput && Object.prototype.hasOwnProperty.call(codexAppInput, 'multiplex')) {
        if (typeof codexAppInput["multiplex"] === 'boolean') {
            persistenceShape = 'present';
        } else {
            delete codexApp["multiplex"];
            invalidPaths.push('runtime.codexApp.multiplex');
        }
    }

    if (source !== 'api' && persistenceShape === 'absent') {
        codexApp["multiplex"] = false;
    }

    if (runtimeInput || source !== 'api') {
        runtime["codexApp"] = codexApp;
        value["runtime"] = runtime;
    }

    return {
        value,
        persistenceShape,
        serverOwnedPaths,
        invalidPaths,
        rejectedPaths,
    };
}

/**
 * settings 객체에 patch를 deep merge
 * perCli와 activeOverrides는 CLI별로 개별 merge (기존 effort/model 보존)
 * @param {object} current - 현재 settings
 * @param {object} patch - 적용할 패치
 * @returns {object} 새 settings (current를 직접 변경하지 않음)
 */
export function mergeSettingsPatch(current: Record<string, any>, patch: Record<string, any>) {
    const result = structuredClone(current);
    const remaining = { ...patch };

    // Deep merge perCli at per-CLI level
    if (remaining["perCli"] && typeof remaining["perCli"] === 'object') {
        result["perCli"] = result["perCli"] || {};
        for (const [cli, cfg] of Object.entries(remaining["perCli"]) as [string, Record<string, any>][]) {
            result["perCli"][cli] = { ...result["perCli"][cli], ...cfg };
        }
        delete remaining["perCli"];
    }

    // Deep merge activeOverrides at per-CLI level
    if (remaining["activeOverrides"] && typeof remaining["activeOverrides"] === 'object') {
        result["activeOverrides"] = result["activeOverrides"] || {};
        for (const [cli, cfg] of Object.entries(remaining["activeOverrides"]) as [string, Record<string, any>][]) {
            result["activeOverrides"][cli] = { ...result["activeOverrides"][cli], ...cfg };
        }
        delete remaining["activeOverrides"];
    }

    // Deep merge nested objects. A key missing from this list is REPLACED wholesale by a
    // partial patch, so `{wiki:{promptDigest:true}}` would silently drop the root and the
    // enabled flag along with it.
    for (const key of ['heartbeat', 'telegram', 'telegramHub', 'discord', 'slack', 'memory', 'stt', 'jawCeo', 'pi', 'tui', 'messaging', 'network', 'wiki']) {
        if (remaining[key] && typeof remaining[key] === 'object') {
            result[key] = { ...result[key], ...remaining[key] };
            delete remaining[key];
        }
    }

    // Deep merge nested network.remoteAccess
    if (remaining["network"]?.remoteAccess && typeof remaining["network"].remoteAccess === 'object') {
        result["network"] = result["network"] || {};
        result["network"].remoteAccess = { ...result["network"].remoteAccess, ...remaining["network"].remoteAccess };
        delete remaining["network"].remoteAccess;
    }

    // runtime.codexApp is a two-level merge boundary: a multiplex-only patch
    // must preserve both other runtime blocks and codexApp-owned siblings.
    if (isPlainRecord(remaining["runtime"])) {
        const runtimePatch = remaining["runtime"];
        result["runtime"] = { ...(result["runtime"] || {}), ...runtimePatch };
        if (isPlainRecord(runtimePatch["codexApp"])) {
            result["runtime"].codexApp = {
                ...(current["runtime"]?.codexApp || {}),
                ...runtimePatch["codexApp"],
            };
        }
        delete remaining["runtime"];
    }

    // Top-level scalar fields
    Object.assign(result, remaining);

    return result;
}
