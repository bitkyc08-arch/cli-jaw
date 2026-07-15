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

const unsupportedAdapter: InstanceSettingsAdapter = {
    decode: () => ({}),
    encode: () => ({}),
};

export function getInstanceSettingsAdapter(id: InstanceSettingsAdapterId): InstanceSettingsAdapter {
    if (id === 'agent') return agentAdapter;
    if (id === 'memory') return memoryAdapter;
    return unsupportedAdapter;
}
