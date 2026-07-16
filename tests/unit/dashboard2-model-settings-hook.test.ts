import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement as h } from 'react';
import * as ReactNamespace from 'react';
import { JSDOM } from 'jsdom';
import type { SettingsRecord } from '../../public/dashboard2/src/features/settings/settings-types.ts';
import type {
    InstanceModelSettingsClient,
    UseInstanceModelSettingsResult,
} from '../../public/dashboard2/src/models/use-instance-model-settings.ts';

const SECRET = 'SECRET_CANARY_MODEL_HOOK_31ce';

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;

    constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
    }

    close(): void { this.closed = true; }

    emit(payload: unknown): void {
        this.onmessage?.({ data: JSON.stringify(payload) });
    }
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const registry: SettingsRecord = {
    codex: {
        defaultModel: 'gpt-5.5',
        defaultEffort: 'medium',
        models: ['gpt-5.5', 'gpt-5.6-sol'],
        efforts: ['low', 'medium', 'high'],
        registryToken: SECRET,
    },
    managerTokens: { token: SECRET },
};

function settings(model = 'gpt-5.5', effort = 'medium'): SettingsRecord {
    return {
        cli: 'codex',
        perCli: { codex: { model: 'gpt-5.5', effort: 'medium', apiKey: SECRET } },
        activeOverrides: { codex: { model, effort, token: SECRET } },
        telegram: { botToken: SECRET },
        discord: { token: SECRET },
        pi: { profiles: [{ apiKey: SECRET }] },
    };
}

async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function mountHook(
    client: InstanceModelSettingsClient,
    port: number | null = 3457,
    mode: 'active' | 'default' = 'active',
    copies = 1,
) {
    FakeEventSource.instances = [];
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:24577/dashboard2/' });
    (globalThis as Record<string, unknown>).React = ReactNamespace;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    for (const [name, value] of Object.entries({
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        EventSource: FakeEventSource,
    })) Object.defineProperty(globalThis, name, { configurable: true, value });
    Object.defineProperty(dom.window.document, 'hidden', { configurable: true, value: false });

    const { createRoot } = await import('react-dom/client');
    const { AppScopeProvider } = await import('../../public/dashboard2/src/state/scope.tsx');
    const { ManagerSyncProvider } = await import('../../public/dashboard2/src/providers/sync-provider.tsx');
    const { useInstanceModelSettings } = await import('../../public/dashboard2/src/models/use-instance-model-settings.ts');
    const latest: Array<UseInstanceModelSettingsResult | null> = Array.from({ length: copies }, () => null);

    function Probe(props: { port: number | null; index: number }) {
        latest[props.index] = useInstanceModelSettings({ port: props.port, client, mode });
        return null;
    }

    const root = createRoot(dom.window.document.getElementById('root')!);
    const render = async (nextPort: number | null): Promise<void> => {
        await act(async () => {
            root.render(h(AppScopeProvider, null,
                h(ManagerSyncProvider, null,
                    h(ReactNamespace.Fragment, null, ...latest.map((_value, index) => (
                        h(Probe, { key: index, port: nextPort, index })
                    ))))));
            await settle();
        });
    };
    await render(port);
    return {
        latest: () => latest[0] as UseInstanceModelSettingsResult,
        all: () => latest as UseInstanceModelSettingsResult[],
        render,
        managerSource: () => FakeEventSource.instances.find(source => source.url === '/api/events'),
        unmount: async () => act(async () => root.unmount()),
    };
}

test('default mode displays and writes only persistent per-CLI settings', async () => {
    const patches: SettingsRecord[] = [];
    const initial = {
        cli: 'codex',
        perCli: { codex: { model: 'gpt-5.5', effort: 'medium' } },
        activeOverrides: { codex: { model: 'gpt-5.6-sol', effort: '' } },
    };
    const client: InstanceModelSettingsClient = {
        fetchSettings: async () => initial,
        fetchRegistry: async () => registry,
        saveSettings: async (_port, patch) => {
            patches.push(patch);
            return {
                ...initial,
                perCli: { codex: { model: 'gpt-5.6-sol', effort: 'high' } },
            };
        },
    };
    const harness = await mountHook(client, 3457, 'default');
    assert.equal(harness.latest().snapshot.selection?.model, 'gpt-5.5');
    assert.equal(harness.latest().snapshot.activeOverrideMasksDefault, true);

    await act(async () => {
        assert.equal(await harness.latest().actions.save({
            ...harness.latest().snapshot.selection!,
            model: 'gpt-5.6-sol',
            effort: 'high',
        }), true);
        await settle();
    });
    assert.deepEqual(patches, [{
        perCli: { codex: { provider: '', model: 'gpt-5.6-sol', effort: 'high' } },
    }]);
    assert.equal(harness.latest().snapshot.selection?.model, 'gpt-5.6-sol');
    await harness.unmount();
});

test('two Chat sessions on one port converge on the same worker-wide active override', async () => {
    let authoritative = settings();
    const client: InstanceModelSettingsClient = {
        fetchSettings: async () => authoritative,
        fetchRegistry: async () => registry,
        saveSettings: async (_port, patch) => {
            const activePatch = (patch['activeOverrides'] as SettingsRecord).codex as SettingsRecord;
            authoritative = settings(String(activePatch['model']), String(activePatch['effort']));
            return authoritative;
        },
    };
    const harness = await mountHook(client, 3457, 'active', 2);
    assert.deepEqual(harness.all().map(result => result.snapshot.selection?.model), ['gpt-5.5', 'gpt-5.5']);

    await act(async () => {
        assert.equal(await harness.all()[0]!.actions.save({
            ...harness.all()[0]!.snapshot.selection!,
            model: 'gpt-5.6-sol',
            effort: 'high',
        }), true);
        harness.managerSource()?.emit({
            topic: 'worker', event: 'worker_settings_change', port: 3457, changedKeys: ['activeOverrides'],
        });
        await settle();
    });
    assert.deepEqual(harness.all().map(result => result.snapshot.selection?.model), ['gpt-5.6-sol', 'gpt-5.6-sol']);
    await harness.unmount();
});

test('hook loads only controlled model state and reports empty inventory without secret leakage', async () => {
    const client: InstanceModelSettingsClient = {
        fetchSettings: async () => settings(),
        fetchRegistry: async () => registry,
        saveSettings: async () => settings(),
    };
    const harness = await mountHook(client);
    assert.equal(harness.latest().snapshot.status, 'ready');
    assert.equal(harness.latest().snapshot.selection?.model, 'gpt-5.5');
    assert.equal(JSON.stringify(harness.latest()).includes(SECRET), false);
    await harness.unmount();

    const emptyHarness = await mountHook({
        ...client,
        fetchRegistry: async () => ({ codex: { models: [], efforts: [], token: SECRET } }),
    });
    assert.equal(emptyHarness.latest().snapshot.status, 'empty');
    assert.equal(emptyHarness.latest().snapshot.catalog?.mutationEnabled, false);
    assert.equal(JSON.stringify(emptyHarness.latest()).includes(SECRET), false);
    await emptyHarness.unmount();

    const errorHarness = await mountHook({
        ...client,
        fetchSettings: async () => { throw new Error(SECRET); },
    });
    assert.equal(errorHarness.latest().snapshot.status, 'error');
    assert.equal(errorHarness.latest().snapshot.error?.code, 'load_failed');
    assert.equal(JSON.stringify(errorHarness.latest()).includes(SECRET), false);
    await errorHarness.unmount();
});

test('hook serializes saves and reloads authoritative state after a failed PUT', async () => {
    const saveResult = deferred<SettingsRecord>();
    let settingsReads = 0;
    const patches: SettingsRecord[] = [];
    const client: InstanceModelSettingsClient = {
        fetchSettings: async () => {
            settingsReads += 1;
            return settings('gpt-5.5', 'medium');
        },
        fetchRegistry: async () => registry,
        saveSettings: async (_port, patch) => {
            patches.push(patch);
            return saveResult.promise;
        },
    };
    const harness = await mountHook(client);
    const next = {
        ...harness.latest().snapshot.selection!,
        model: 'gpt-5.6-sol',
        effort: '',
    };
    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    await act(async () => {
        first = harness.latest().actions.save(next);
        duplicate = harness.latest().actions.save(next);
        await settle();
    });
    assert.equal(await duplicate, false);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], {
        perCli: { codex: { provider: '' } },
        activeOverrides: { codex: { model: 'gpt-5.6-sol', effort: '' } },
    });
    assert.equal(harness.latest().snapshot.status, 'saving');

    await act(async () => {
        saveResult.reject(new Error(SECRET));
        assert.equal(await first, false);
        await settle();
    });
    assert.equal(settingsReads, 2, 'failure must perform an authoritative GET');
    assert.equal(harness.latest().snapshot.status, 'error');
    assert.equal(harness.latest().snapshot.selection?.model, 'gpt-5.5');
    assert.equal(harness.latest().snapshot.error?.code, 'save_failed');
    assert.equal(JSON.stringify(harness.latest()).includes(SECRET), false);
    await harness.unmount();
});

test('port generation aborts old work and discards a late accepted old-port save', async () => {
    const oldSave = deferred<SettingsRecord>();
    let oldSaveSignal: AbortSignal | null = null;
    const client: InstanceModelSettingsClient = {
        fetchSettings: async port => settings(port === 3457 ? 'gpt-5.5' : 'gpt-5.6-sol'),
        fetchRegistry: async () => registry,
        saveSettings: async (port, _patch, options) => {
            assert.equal(port, 3457);
            oldSaveSignal = options.signal;
            return oldSave.promise;
        },
    };
    const harness = await mountHook(client, 3457);
    let pending!: Promise<boolean>;
    await act(async () => {
        pending = harness.latest().actions.save({
            ...harness.latest().snapshot.selection!, model: 'gpt-5.6-sol',
        });
        await settle();
    });
    await harness.render(3458);
    assert.equal(oldSaveSignal?.aborted, true);
    assert.equal(harness.latest().snapshot.port, 3458);
    assert.equal(harness.latest().snapshot.selection?.model, 'gpt-5.6-sol');

    await act(async () => {
        oldSave.resolve(settings('gpt-5.5'));
        assert.equal(await pending, false);
        await settle();
    });
    assert.equal(harness.latest().snapshot.port, 3458);
    assert.equal(harness.latest().snapshot.selection?.model, 'gpt-5.6-sol');
    await harness.unmount();
});

test('same-port worker settings events coalesce while wrong-port events are discarded', async () => {
    let settingsReads = 0;
    let registryReads = 0;
    const pendingSave = deferred<SettingsRecord>();
    const client: InstanceModelSettingsClient = {
        fetchSettings: async () => { settingsReads += 1; return settings(); },
        fetchRegistry: async () => { registryReads += 1; return registry; },
        saveSettings: async () => pendingSave.promise,
    };
    const harness = await mountHook(client);
    const source = harness.managerSource();
    assert.ok(source);

    await act(async () => {
        source.emit({ topic: 'worker', event: 'worker_settings_change', port: 9999, changedKeys: null });
        await settle();
    });
    assert.equal(settingsReads, 1);

    await act(async () => {
        source.emit({ topic: 'worker', event: 'worker_settings_change', port: 3457, changedKeys: ['perCli'] });
        source.emit({ topic: 'worker', event: 'worker_settings_change', port: 3457, changedKeys: ['activeOverrides'] });
        await settle();
    });
    assert.equal(settingsReads, 2, 'same-turn events must coalesce to one settings reload');
    assert.equal(registryReads, 2, 'same-turn events must coalesce to one registry reload');
    assert.equal(harness.latest().snapshot.status, 'ready');

    let save!: Promise<boolean>;
    await act(async () => {
        save = harness.latest().actions.save({
            ...harness.latest().snapshot.selection!, model: 'gpt-5.6-sol',
        });
        source.emit({ topic: 'worker', event: 'worker_settings_change', port: 3457, changedKeys: ['perCli'] });
        source.emit({ topic: 'worker', event: 'worker_settings_change', port: 3457, changedKeys: ['activeOverrides'] });
        await settle();
    });
    assert.equal(settingsReads, 2, 'events must not overlap an in-flight save');
    await act(async () => {
        pendingSave.resolve(settings('gpt-5.6-sol'));
        assert.equal(await save, true);
        await settle();
    });
    assert.equal(settingsReads, 3, 'in-flight events must coalesce to one post-save reload');
    assert.equal(registryReads, 3);
    await harness.unmount();
});
