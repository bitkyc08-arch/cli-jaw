import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';
import type { SettingsData } from '../../public/js/features/settings-types.ts';

const writes: Array<{ path: string; method: string; body: unknown }> = [];
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function settings(permissions: string): SettingsData {
    return { cli: 'claude', workingDir: '/fixture/project', permissions, perCli: {}, projectDirs: [],
        messaging: { enabledChannels: [] }, runtimeDefaultMigration: null, multiSessionDefaultMigration: null };
}
let readSettings: () => Promise<SettingsData | null>;
let saveSettings: (body: unknown) => Promise<SettingsData | null>;
mock.module('../../public/js/provider-icons.js', { namedExports: {
    providerIcon() { return ''; }, providerLabel(value: string) { return value; },
} });
mock.module('../../public/js/api.js', { namedExports: {
    API_BASE: '',
    async api(path: string) {
        if (path === '/api/settings') return readSettings();
        if (path === '/api/cli-registry') return { claude: { label: 'Claude', models: ['sonnet'], efforts: [] } };
        return null;
    },
    async apiJson(path: string, method: string, body: unknown) {
        writes.push({ path, method, body });
        return saveSettings(body);
    },
    async getAuthToken() { return ''; },
    async apiFire(path: string, method: string, body: unknown) { writes.push({ path, method, body }); },
} });
let setPerm: typeof import('../../public/js/features/settings-core.ts')['setPerm'];
let loadSettings: typeof import('../../public/js/features/settings-core.ts')['loadSettings'];
let updateSettings: typeof import('../../public/js/features/settings-core.ts')['updateSettings'];
let waitForSettingsSaveIdle: typeof import('../../public/js/features/settings-core.ts')['waitForSettingsSaveIdle'];
function select() {
    const el = document.querySelector<HTMLSelectElement>('#selPerm');
    assert.ok(el, 'permission control exists');
    return el;
}
function readout() { return document.getElementById('configuredPermText')!.textContent; }
function errorAlert() { return document.getElementById('permSaveError')!; }

test.before(async () => {
    setupWebUiDom();
    ({ setPerm, loadSettings, updateSettings, waitForSettingsSaveIdle } = await import('../../public/js/features/settings-core.ts'));
});
test.beforeEach(() => {
    writes.length = 0;
    readSettings = async () => settings('auto');
    saveSettings = async () => settings('safe');
    document.getElementById('policyFixture')?.remove();
    const page = new window.DOMParser().parseFromString(readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8'), 'text/html');
    const fixture = document.importNode(page.querySelector('.perm-toggle')!.parentElement!, true);
    fixture.id = 'policyFixture';
    document.body.append(fixture);
});
test.after(() => { resetWebUiDom(); mock.restoreAll(); });

for (const [value, label] of [
    ['auto', 'Auto'], ['safe', 'Safe'], [[], 'Custom (0 entries)'], [['auto'], 'Custom (1 entry)'],
    [[' read ', ''], 'Custom (2 entries)'], [null, 'Not provided'], [undefined, 'Not provided'],
    ['AUTO', 'Unrecognized'], ['<img src=x onerror=alert(1)>', 'Unrecognized'],
    [{ secret: 'DO_NOT_SHOW' }, 'Unrecognized'], [['read', 1], 'Unrecognized'],
] as const) test(`Classic configured-policy readout ${label}: ${JSON.stringify(value)}`, () => {
    const before = structuredClone(value);
    void setPerm(value, false);
    assert.equal(readout(), `Configured policy: ${label}`, 'hydration updates synchronously');
    assert.equal(document.querySelector('.perm-btn')!.classList.contains('perm-auto'), value === 'auto');
    assert.equal(select().value, value === 'auto' || value === 'safe' ? value : '');
    if (select().value === '') assert.equal(select().selectedOptions[0]!.disabled, true);
    assert.equal(select().disabled, false);
    assert.deepEqual(value, before);
    assert.deepEqual(writes, []);
    assert.equal(document.querySelector('.perm-toggle img'), null);
    assert.doesNotMatch(document.querySelector('.perm-toggle')!.textContent!, /DO_NOT_SHOW|onerror/);
});

test('Classic missing readout is a no-op and does not write', () => {
    document.getElementById('policyFixture')!.remove();
    void setPerm('safe', false);
    assert.deepEqual(writes, []);
});

test('Classic native select has accessible label, disabled placeholder, and no initial write', () => {
    assert.equal(select().tagName, 'SELECT');
    assert.equal(select().disabled, true);
    const labelId = select().getAttribute('aria-labelledby');
    assert.ok(labelId && document.getElementById(labelId)?.textContent?.trim());
    assert.deepEqual(Array.from(select().options).filter(option => !option.disabled).map(option => option.value), ['auto', 'safe']);
    assert.equal(errorAlert().getAttribute('role'), 'alert');
    assert.deepEqual(writes, []);
});

for (const [from, to] of [['auto', 'safe'], ['safe', 'auto']] as const) {
    test(`Classic saves ${from} to ${to} exactly and waits for confirmation`, async () => {
        void setPerm(from, false);
        const pending = deferred<SettingsData | null>();
        saveSettings = () => pending.promise;
        select().value = to;
        const saving = setPerm(to);
        try {
            assert.deepEqual(writes, [{ path: '/api/settings', method: 'PUT', body: { permissions: to } }]);
            assert.equal(select().disabled, true);
            assert.equal(readout(), `Configured policy: ${from === 'auto' ? 'Auto' : 'Safe'}`);
            await setPerm(to);
            await setPerm(from);
            assert.equal(writes.length, 1, 'pending choices do not enqueue another save');
        } finally { pending.resolve(settings(to)); await saving; }
        assert.equal(readout(), `Configured policy: ${to === 'auto' ? 'Auto' : 'Safe'}`);
        assert.equal(select().value, to);
        assert.equal(select().disabled, false);
    });
}

test('Classic same-value and invalid selections never write', async () => {
    void setPerm('safe', false);
    for (const value of ['safe', '', 'AUTO', null, undefined, ['auto'], { permissions: 'auto' }]) await setPerm(value);
    assert.deepEqual(writes, []);
    assert.equal(readout(), 'Configured policy: Safe');
    assert.equal(select().value, 'safe');
});

test('Classic displays the confirmed response rather than the submitted choice', async () => {
    void setPerm('auto', false);
    saveSettings = async () => settings('auto');
    await setPerm('safe');
    assert.equal(writes.length, 1);
    assert.equal(readout(), 'Configured policy: Auto');
    assert.equal(select().value, 'auto');
});

for (const prior of ['auto', ['read']] as const) {
    test(`Classic failed save restores ${JSON.stringify(prior)} and later success clears the alert`, async () => {
        void setPerm(prior, false);
        const before = readout();
        saveSettings = async () => null;
        select().value = 'safe';
        await setPerm('safe');
        assert.equal(readout(), before);
        assert.equal(select().value, prior === 'auto' ? 'auto' : '');
        assert.equal(select().disabled, false);
        assert.equal(errorAlert().getAttribute('role'), 'alert');
        assert.equal(errorAlert().hidden, false);
        assert.ok(errorAlert().textContent?.trim());
        saveSettings = async () => settings('safe');
        await setPerm('safe');
        assert.equal(readout(), 'Configured policy: Safe');
        assert.ok(errorAlert().hidden || !errorAlert().textContent?.trim());
    });
}

test('Classic permission saves participate in the shared save-idle barrier', async () => {
    void setPerm('auto', false);
    const pending = deferred<SettingsData | null>();
    saveSettings = () => pending.promise;
    const saving = setPerm('safe');
    let idle = false;
    const waiting = waitForSettingsSaveIdle().then(() => { idle = true; });
    try { await Promise.resolve(); assert.equal(idle, false); }
    finally { pending.resolve(settings('safe')); await saving; await waiting; }
    assert.equal(idle, true);
});

for (const timing of ['before PUT', 'during PUT'] as const) {
    test(`Classic GET begun ${timing} cannot overwrite a completed permission save`, async () => {
        void setPerm('auto', false);
        const stale = deferred<SettingsData | null>();
        const readStarted = deferred<void>();
        const put = deferred<SettingsData | null>();
        readSettings = () => { readStarted.resolve(); return stale.promise; };
        saveSettings = () => put.promise;
        let saving: ReturnType<typeof setPerm> = Promise.resolve();
        if (timing === 'during PUT') saving = setPerm('safe');
        const loading = loadSettings();
        await readStarted.promise;
        if (timing === 'before PUT') saving = setPerm('safe');
        put.resolve(settings('safe'));
        await saving;
        stale.resolve(settings('auto'));
        await loading;
        assert.equal(readout(), 'Configured policy: Safe');
        assert.equal(select().value, 'safe');
        assert.equal(select().disabled, false);
        assert.equal(writes.length, 1);
        readSettings = async () => settings('auto');
        await loadSettings();
        assert.equal(readout(), 'Configured policy: Auto', 'fresh reads still hydrate after the save');
        assert.equal(writes.length, 1);
    });
}

test('Classic GET completing while PUT is pending does not hydrate permissions', async () => {
    void setPerm('safe', false);
    const put = deferred<SettingsData | null>();
    saveSettings = () => put.promise;
    const saving = setPerm('auto');
    try {
        await loadSettings();
        assert.equal(readout(), 'Configured policy: Safe');
        assert.equal(select().disabled, true);
    } finally { put.resolve(settings('auto')); await saving; }
    assert.equal(readout(), 'Configured policy: Auto');
});

for (const first of ['CLI settings', 'permissions'] as const) {
    test(`Classic save-idle barrier waits for both writes when ${first} completes first`, async () => {
        void setPerm('auto', false);
        const permissionResponse = deferred<SettingsData | null>();
        const cliResponse = deferred<SettingsData | null>();
        saveSettings = body => {
            assert.ok(body && typeof body === 'object');
            return 'permissions' in body ? permissionResponse.promise : cliResponse.promise;
        };
        const permissionSaving = setPerm('safe');
        const cliSaving = updateSettings();
        let idle = false;
        let waiting: Promise<void> = Promise.resolve();
        try {
            assert.deepEqual(writes, [
                { path: '/api/settings', method: 'PUT', body: { permissions: 'safe' } },
                { path: '/api/settings', method: 'PUT', body: { cli: 'claude' } },
            ]);
            if (first === 'CLI settings') {
                cliResponse.resolve(settings('auto'));
                await cliSaving;
            } else {
                permissionResponse.resolve(settings('safe'));
                await permissionSaving;
            }
            waiting = waitForSettingsSaveIdle().then(() => { idle = true; });
            // An already-resolved barrier schedules its callback before this continuation;
            // a correct barrier remains blocked by the explicitly unresolved response.
            await Promise.resolve();
            assert.equal(idle, false, 'save-idle must remain pending until the other write settles');
        } finally {
            permissionResponse.resolve(settings('safe'));
            cliResponse.resolve(settings('safe'));
            await Promise.all([permissionSaving, cliSaving, waiting]);
        }
        assert.equal(idle, true);
        assert.equal(readout(), 'Configured policy: Safe');
    });
}
