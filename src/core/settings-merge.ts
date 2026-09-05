// ─── Settings Merge Logic ────────────────────────────
// Phase 9.4 — server.js의 applySettingsPatch에서 추출한 deep merge 로직

import { mergeAckSettings } from '../messaging/ack-reaction.js';
import { mergeSlackAutoJoin } from '../slack/auto-join.js';
import { isRuntimeTransport, isSwitchableNativeCli } from '../agent/runtime/selection.js';
import { isPresentationMode } from '../shared/presentation.js';

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

    if (Object.hasOwn(input, 'presentation')) {
        if (!isPlainRecord(input['presentation'])) {
            delete value['presentation'];
            invalidPaths.push('presentation');
        } else {
            const presentation = { ...input['presentation'] };
            if (Object.hasOwn(presentation, 'mode') && !isPresentationMode(presentation['mode'])) {
                delete presentation['mode'];
                invalidPaths.push('presentation.mode');
            }
            value['presentation'] = presentation;
        }
    }

    if (isPlainRecord(input['perCli'])) {
        const perCli = Object.fromEntries(Object.entries(input['perCli']).map(([cli, entry]) => {
            if (!isPlainRecord(entry)) return [cli, entry];
            const provider = { ...entry };
            if (isSwitchableNativeCli(cli) && Object.hasOwn(provider, 'transport')
                && !isRuntimeTransport(provider['transport'])) {
                delete provider['transport'];
                invalidPaths.push(`perCli.${cli}.transport`);
            }
            return [cli, provider];
        }));
        value['perCli'] = perCli;
    }

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

    // `multiSession` has to be a plain object or not be here at all. A non-object survives
    // the merge as-is and then meets `if (!s["multiSession"])` in migrateSettings, which
    // reads falsy as absent and fills the block with the current defaults — so a single
    // `{"multiSession": null}` would switch sessions on for a user who never accepted the
    // migration. Both ingresses that can carry one, the API patch and the settings-file
    // watcher, pass through here, which is why the guard lives in this function rather
    // than at either call site (110 §4b-3).
    if (Object.prototype.hasOwnProperty.call(input, 'multiSession') && !isPlainRecord(input["multiSession"])) {
        delete value["multiSession"];
        invalidPaths.push('multiSession');
    } else if (isPlainRecord(input["multiSession"])) {
        const block = { ...input["multiSession"] };
        // Same reasoning one level down: a non-object `channels` reaches the per-channel
        // reads as something that is not indexable.
        if (Object.prototype.hasOwnProperty.call(block, 'channels') && !isPlainRecord(block["channels"])) {
            delete block["channels"];
            invalidPaths.push('multiSession.channels');
        }
        value["multiSession"] = block;
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
    if (remaining["dispatchApproval"]?.operators && typeof remaining["dispatchApproval"].operators === 'object') {
        result["dispatchApproval"] = result["dispatchApproval"] || {};
        remaining["dispatchApproval"] = { ...remaining["dispatchApproval"] };
        result["dispatchApproval"].operators = {
            ...(result["dispatchApproval"].operators || {}),
            ...remaining["dispatchApproval"].operators,
        };
        delete remaining["dispatchApproval"].operators;
    }

    for (const key of ['heartbeat', 'telegram', 'telegramHub', 'discord', 'slack', 'dispatchApproval', 'memory', 'stt', 'jawCeo', 'pi', 'tui', 'messaging', 'network', 'wiki', 'presentation']) {
        if (remaining[key] && typeof remaining[key] === 'object') {
            result[key] = { ...result[key], ...remaining[key] };
            delete remaining[key];
        }
    }

    // The loop above merges channel objects one level deep, so a patch carrying
    // only {ack:{enabled:true}} would drop scope, emoji and removeAfterReply.
    // Reads `patch` rather than `remaining` because the loop already deleted the
    // key. Shares mergeAckSettings with the boot merge in config.ts so the three
    // ingresses (boot/api/watch) cannot diverge.
    for (const key of ['telegram', 'discord', 'slack']) {
        const patchChannel = patch[key];
        if (!patchChannel || typeof patchChannel !== 'object') continue;
        const patchAck = (patchChannel as Record<string, any>)["ack"];
        const currentChannel = current[key] as Record<string, any> | undefined;
        if (patchAck && typeof patchAck === 'object' && !Array.isArray(patchAck)) {
            result[key] = {
                ...result[key],
                ack: mergeAckSettings(currentChannel?.["ack"], patchAck),
            };
        }
        // slack.autoJoin is the same nested-group case, and its budget reaches
        // a loop that joins real channels — so this path normalizes as well as
        // merges. A PUT carrying {autoJoin:{enabled:false}} must not erase
        // maxJoinsPerRun, and {maxJoinsPerRun:-1} must not reach the runner.
        if (key === 'slack') {
            const slackPatch = patchChannel as Record<string, unknown>;
            const patchAutoJoin = slackPatch["autoJoin"];
            // Any mention of the key is repaired, including a malformed one.
            // Testing for a well-formed object would let {autoJoin:null} and
            // {autoJoin:'yes'} through the one-level spread above and survive
            // to disk, where the next boot reads them as "absent" and quietly
            // restores default-on. A patch that names the key gets a valid
            // block or nothing.
            if ('autoJoin' in slackPatch) {
                result[key] = {
                    ...result[key],
                    autoJoin: mergeSlackAutoJoin(currentChannel?.["autoJoin"], patchAutoJoin),
                };
            }
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

    // multiSession.channels is the same shape of boundary. An enabled-only patch must
    // keep midRunPolicy and the channel gates, and a single-channel patch must keep the
    // other two channels — which is exactly what a per-channel session gate will send.
    if (isPlainRecord(remaining["multiSession"])) {
        const sessionPatch = remaining["multiSession"];
        result["multiSession"] = { ...(result["multiSession"] || {}), ...sessionPatch };
        if (isPlainRecord(sessionPatch["channels"])) {
            result["multiSession"].channels = {
                ...(current["multiSession"]?.channels || {}),
                ...sessionPatch["channels"],
            };
        }
        delete remaining["multiSession"];
    }

    // Top-level scalar fields
    Object.assign(result, remaining);

    return result;
}
