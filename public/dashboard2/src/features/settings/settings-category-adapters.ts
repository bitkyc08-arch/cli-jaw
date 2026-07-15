import type { InstanceSettingsAdapterId, SettingsRecord } from './settings-types.ts';

export interface InstanceSettingsAdapter {
    decode(root: SettingsRecord): SettingsRecord;
    encode(draft: SettingsRecord, initial: SettingsRecord, root: SettingsRecord): SettingsRecord;
}

function record(value: unknown): SettingsRecord {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as SettingsRecord : {};
}

function changed(draft: SettingsRecord, initial: SettingsRecord, key: string): boolean {
    return !Object.is(draft[key], initial[key]);
}

const agentAdapter: InstanceSettingsAdapter = {
    decode(root) {
        const cli = typeof root['cli'] === 'string' ? root['cli'] : '';
        const cliSettings = record(record(root['perCli'])[cli]);
        return { model: typeof cliSettings['model'] === 'string' ? cliSettings['model'] : '' };
    },
    encode(draft, initial, root) {
        if (!changed(draft, initial, 'model')) return {};
        const cli = typeof root['cli'] === 'string' ? root['cli'].trim() : '';
        if (!cli || !Object.hasOwn(record(root['perCli']), cli)) {
            throw new Error('Selected CLI settings are unavailable');
        }
        if (typeof draft['model'] !== 'string') throw new Error('Model must be a string');
        return { perCli: { [cli]: { model: draft['model'] } } };
    },
};

const memoryFields = [
    ['enabled', 'enabled'],
    ['flushEvery', 'flushEvery'],
    ['retentionDays', 'retentionDays'],
    ['autoReflect', 'autoReflectAfterFlush'],
] as const;

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
        throw new Error(`${label} must be an integer from ${min} to ${max}`);
    }
    return value as number;
}

const memoryAdapter: InstanceSettingsAdapter = {
    decode(root) {
        const memory = record(root['memory']);
        return Object.fromEntries(memoryFields.map(([uiKey, canonicalKey]) => [uiKey, memory[canonicalKey]]));
    },
    encode(draft, initial) {
        const memory: SettingsRecord = {};
        if (changed(draft, initial, 'enabled')) {
            if (typeof draft['enabled'] !== 'boolean') throw new Error('Memory enabled must be boolean');
            memory['enabled'] = draft['enabled'];
        }
        if (changed(draft, initial, 'flushEvery')) {
            memory['flushEvery'] = boundedInteger(draft['flushEvery'], 'Flush every', 1, 100);
        }
        if (changed(draft, initial, 'retentionDays')) {
            memory['retentionDays'] = boundedInteger(draft['retentionDays'], 'Retention days', 1, 3650);
        }
        if (changed(draft, initial, 'autoReflect')) {
            if (typeof draft['autoReflect'] !== 'boolean') throw new Error('Auto reflect must be boolean');
            memory['autoReflectAfterFlush'] = draft['autoReflect'];
        }
        return Object.keys(memory).length > 0 ? { memory } : {};
    },
};

const remoteAccessModes = ['off', 'http-only', 'full'] as const;
const remoteAccessFields = [
    'mode',
    'trustProxies',
    'trustForwardedFor',
    'publicOriginHint',
    'requireAuth',
] as const;

function remoteAccessMode(value: unknown): typeof remoteAccessModes[number] {
    if (typeof value !== 'string' || !remoteAccessModes.includes(value as typeof remoteAccessModes[number])) {
        throw new Error('Remote access mode must be off, http-only, or full');
    }
    return value as typeof remoteAccessModes[number];
}

function booleanValue(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
    return value;
}

function publicOriginHint(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Public origin hint must be a string');
    const trimmed = value.trim();
    if (!trimmed) return '';
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new Error('Public origin hint must be an absolute HTTP(S) origin');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Public origin hint must be an absolute HTTP(S) origin without a path, query, or hash');
    }
    return url.origin;
}

const networkAdapter: InstanceSettingsAdapter = {
    decode(root) {
        const network = record(root['network']);
        const remoteAccess = record(network['remoteAccess']);
        return {
            bindHost: typeof network['bindHost'] === 'string' ? network['bindHost'] : '127.0.0.1',
            lanBypass: typeof network['lanBypass'] === 'boolean' ? network['lanBypass'] : false,
            remoteAccess: {
                mode: typeof remoteAccess['mode'] === 'string' && remoteAccessModes.includes(remoteAccess['mode'] as typeof remoteAccessModes[number])
                    ? remoteAccess['mode']
                    : 'off',
                trustProxies: typeof remoteAccess['trustProxies'] === 'boolean' ? remoteAccess['trustProxies'] : false,
                trustForwardedFor: typeof remoteAccess['trustForwardedFor'] === 'boolean' ? remoteAccess['trustForwardedFor'] : false,
                publicOriginHint: typeof remoteAccess['publicOriginHint'] === 'string' ? remoteAccess['publicOriginHint'] : '',
                requireAuth: typeof remoteAccess['requireAuth'] === 'boolean' ? remoteAccess['requireAuth'] : true,
            },
        };
    },
    encode(draft, initial) {
        const draftRemoteAccess = record(draft['remoteAccess']);
        const initialRemoteAccess = record(initial['remoteAccess']);
        const bindHostChanged = changed(draft, initial, 'bindHost');
        const lanBypassChanged = changed(draft, initial, 'lanBypass');
        const remoteAccessChanged = remoteAccessFields.some((key) =>
            !Object.is(draftRemoteAccess[key], initialRemoteAccess[key]));
        if (!bindHostChanged && !lanBypassChanged && !remoteAccessChanged) return {};

        const network: SettingsRecord = {};
        if (bindHostChanged) {
            if (typeof draft['bindHost'] !== 'string' || !draft['bindHost'].trim()) {
                throw new Error('Bind host must be a non-empty string');
            }
            network['bindHost'] = draft['bindHost'].trim();
        }
        if (lanBypassChanged) {
            network['lanBypass'] = booleanValue(draft['lanBypass'], 'LAN bypass');
        }
        network['remoteAccess'] = {
            mode: remoteAccessMode(draftRemoteAccess['mode']),
            trustProxies: booleanValue(draftRemoteAccess['trustProxies'], 'Trust proxies'),
            trustForwardedFor: booleanValue(draftRemoteAccess['trustForwardedFor'], 'Trust forwarded-for'),
            publicOriginHint: publicOriginHint(draftRemoteAccess['publicOriginHint']),
            requireAuth: booleanValue(draftRemoteAccess['requireAuth'], 'Require authentication'),
        };
        return { network };
    },
};

const unsupportedAdapter: InstanceSettingsAdapter = {
    decode: () => ({}),
    encode: () => ({}),
};

export function getInstanceSettingsAdapter(id: InstanceSettingsAdapterId): InstanceSettingsAdapter {
    if (id === 'agent') return agentAdapter;
    if (id === 'memory') return memoryAdapter;
    if (id === 'network') return networkAdapter;
    return unsupportedAdapter;
}
