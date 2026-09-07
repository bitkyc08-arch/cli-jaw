import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

const chatSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/features/chat.ts'), 'utf8');
const requests: Array<{ path: string; method: string; body?: unknown }> = [];
let snapshot = { cli: 'claude', workingDir: '/fixture', permissions: 'safe', locale: 'en' };
let putResult: Promise<unknown>;
let putStarted: () => void = () => {};
mock.module('../../public/js/provider-icons.js', { namedExports: {
    providerIcon: () => '', providerLabel: (value: string) => value,
} });
mock.module('../../public/js/api.js', { namedExports: {
    API_BASE: '', getAuthToken: async () => '', apiFire: async () => {},
    api: async (requestPath: string) => {
        requests.push({ path: requestPath, method: 'GET' });
        return requestPath === '/api/settings' ? snapshot : null;
    },
    apiJson: async (requestPath: string, method: string, body: unknown) => {
        requests.push({ path: requestPath, method, body });
        putStarted();
        return putResult;
    },
} });
let settings: typeof import('../../public/js/features/settings-core.ts');
let ui: typeof import('../../public/js/ui.ts');
test.before(async () => {
    setupWebUiDom();
    settings = await import('../../public/js/features/settings-core.ts');
    ui = await import('../../public/js/ui.ts');
});
test.beforeEach(() => {
    document.body.innerHTML = `<span id="headerCli">claude</span>
        <div id="tabAgents" class="tab-content active">
            <select id="selCli"><option>claude</option><option>codex</option></select>
            <select id="selCliProvider"></select><select id="selModel"></select><select id="selEffort"></select>
        </div><div id="tabSettings" class="tab-content"><iframe class="settings-frame"></iframe></div>`;
    requests.length = 0;
    snapshot = { cli: 'claude', workingDir: '/fixture', permissions: 'safe', locale: 'en' };
    putResult = Promise.resolve({ cli: 'codex' });
    putStarted = () => {};
});
test.after(() => { resetWebUiDom(); mock.restoreAll(); });

test('SSR-001/002: Agents save barrier waits for confirmed PUT before releasing chat', async () => {
    (document.getElementById('selCli') as HTMLSelectElement).value = 'codex';
    let resolvePut!: (value: unknown) => void;
    putResult = new Promise(resolve => { resolvePut = resolve; });
    const write = settings.updateSettings();
    let released = false;
    const waiting = settings.waitForSettingsSaveIdle().then(() => { released = true; });
    await Promise.resolve();
    assert.equal(released, false);
    assert.equal(document.getElementById('headerCli')?.textContent, 'claude');
    assert.deepEqual(requests, [{ path: '/api/settings', method: 'PUT', body: { cli: 'codex' } }]);
    resolvePut({ cli: 'codex' });
    await write;
    await waiting;
    assert.equal(released, true);
    assert.equal(document.getElementById('headerCli')?.textContent, 'Codex');
});

test('SSR-003: failed Agents save restores authoritative CLI before releasing barrier', async () => {
    (document.getElementById('selCli') as HTMLSelectElement).value = 'codex';
    putResult = Promise.resolve(null);
    await settings.updateSettings();
    await settings.waitForSettingsSaveIdle();
    assert.ok(requests.some(request => request.method === 'GET' && request.path === '/api/settings'));
    assert.equal((document.getElementById('selCli') as HTMLSelectElement).value, 'claude');
    assert.equal(document.getElementById('headerCli')?.textContent, 'Claude');
});

test('parent Save does nothing for Settings; Agents still sends one PUT', async () => {
    const settingsTab = document.getElementById('tabSettings')!;
    settingsTab.classList.add('active');
    ui.handleSave();
    // Flush the old dynamic-import path too: a removed guard would now write.
    await import('../../public/js/features/settings.js');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests.filter(request => request.method === 'PUT').length, 0);
    settingsTab.classList.remove('active');
    const started = new Promise<void>(resolve => { putStarted = resolve; });
    ui.handleSave();
    await started;
    await settings.waitForSettingsSaveIdle();
    assert.equal(requests.filter(request => request.method === 'PUT').length, 1);
});

test('SSR-004: chat waits for pending settings save before sending message', () => {
    assert.match(chatSrc, /import\s+\{\s*waitForSettingsSaveIdle\s*\}\s+from\s+['"]\.\/settings-core\.js['"]/);
    const waitIdx = chatSrc.indexOf('await waitForSettingsSaveIdle()');
    assert.ok(waitIdx > -1, 'chat must wait for pending settings save');

    const sendPoints = [
        ['await handleSlashCommandResponse(text, await postSlashCommand(text))', 'slash command POST'],
        ['await handleSlashCommandResponse(commandText, commandResponse', 'slash attachment command POST'],
        ["apiJson('/api/message', 'POST', withCurrentSessionBody({ prompt }))", 'file attachment message POST'],
        ['postChatMessage(text)', 'normal message POST'],
    ] as const;

    for (const [needle, label] of sendPoints) {
        const sendIdx = chatSrc.indexOf(needle);
        assert.ok(sendIdx > -1, `${label} should exist`);
        assert.ok(sendIdx > waitIdx, `${label} must happen after settings wait`);
    }
});
