// WP5A — keep the browserless QA preload fixture aligned with the TypeScript contract.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDesktopBridgeFixture } from '../../scripts/qa/fixture-lib.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CONTRACT = readFileSync(
    join(ROOT, 'public/dashboard2/src/providers/desktop-bridge-contract.ts'),
    'utf8',
);

function makeFixture(scenario = 'ready') {
    const target: Record<string, unknown> = {};
    const bridge = buildDesktopBridgeFixture(
        { scenario, terminal: true, diff: true, browser: true },
        target,
    );
    return { bridge, target };
}

function exactKeys(value: object, expected: string[]): void {
    assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function interfaceMembers(interfaceName: string): string[] {
    const declaration = CONTRACT.match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(declaration, `${interfaceName} must exist in the contract`);
    return [...declaration[1].matchAll(/^ {4}(\w+)\??(?:\(|:)/gm)].map((match) => match[1]);
}

test('fixture methods stay in lockstep with every contract method they stub', () => {
    const { bridge } = makeFixture();
    // These groups are complete stubs. Deriving the method lists from the
    // contract means a newly added or renamed method fails this test directly.
    const terminalMethods = interfaceMembers('TerminalBridgeApi');
    const diffMethods = interfaceMembers('DiffBridgeApi');
    const browserMethods = interfaceMembers('BrowserBridgeApi');
    const desktopMembers = interfaceMembers('DesktopPreloadApi');
    assert.ok(desktopMembers.includes('identify'));
    assert.ok(desktopMembers.includes('getHomePath'));

    exactKeys(bridge, ['identify', 'getHomePath', 'terminal', 'diff', 'browser']);
    exactKeys(bridge.terminal, terminalMethods);
    exactKeys(bridge.diff, diffMethods);
    exactKeys(bridge.browser, browserMethods);
});

test('identity and terminal responses mirror the declared envelopes', async () => {
    const { bridge } = makeFixture('restored');
    assert.match(CONTRACT, /name: 'cli-jaw-desktop';\s*electron: true;/);
    assert.deepEqual(bridge.identify(), { name: 'cli-jaw-desktop', electron: true });
    assert.equal(bridge.getHomePath(), '/tmp/wp5a-fixture');
    assert.equal(bridge.getHomePath() instanceof Promise, false, 'getHomePath is synchronous in DesktopPreloadApi');

    const listed = await bridge.terminal.list();
    exactKeys(listed, ['ok', 'sessions']);
    exactKeys(listed.sessions[0], ['id', 'shell', 'cwd', 'port', 'seq', 'cols', 'rows', 'buffer']);
    assert.match(CONTRACT, /rows: number;\s*buffer: string;/);

    const created = await bridge.terminal.create();
    exactKeys(created, ['ok', 'id', 'shell', 'cwd']);
    assert.equal(await bridge.terminal.write(created.id, 'pwd\n'), undefined);
    assert.equal(await bridge.terminal.resize(created.id, 100, 40), undefined);
    assert.equal(await bridge.terminal.kill(created.id), undefined);
    assert.match(CONTRACT, /write\(id: string, data: string\): Promise<void>;/);
    assert.match(CONTRACT, /resize\(id: string, cols: number, rows: number\): Promise<void>;/);
    assert.match(CONTRACT, /kill\(id: string\): Promise<void>;/);
});

test('diff responses use contract field names and envelopes', async () => {
    const { bridge } = makeFixture();
    const input = [{ path: '/tmp/wp5a-fixture', label: 'Fixture', source: 'working-dir' }];
    const candidates = await bridge.diff.getRepoCandidates(input);
    exactKeys(candidates, ['ok', 'candidates']);
    exactKeys(candidates.candidates[0], ['path', 'label', 'source', 'root', 'branch', 'head', 'dirty']);

    const scm = await bridge.diff.getScmSnapshot('/tmp/wp5a-fixture');
    exactKeys(scm, ['ok', 'snapshot']);
    exactKeys(scm.snapshot, ['repoRoot', 'branch', 'head', 'dirty', 'groups']);
    exactKeys(scm.snapshot.groups[0], ['id', 'label', 'files']);
    exactKeys(scm.snapshot.groups[0].files[0], ['path', 'repoRelativePath', 'kind', 'staged', 'unstaged', 'conflict']);

    const summary = await bridge.diff.getDiffSummary('/tmp/wp5a-fixture', { mode: 'unstaged' });
    exactKeys(summary.files[0], ['path', 'status', 'insertions', 'deletions']);
    assert.match(CONTRACT, /insertions: number; deletions: number/);
    assert.doesNotMatch(JSON.stringify(summary), /additions/);

    const operation = await bridge.diff.runScmOperation('/tmp/wp5a-fixture', { kind: 'stage', paths: ['src/fixture.ts'] });
    exactKeys(operation, ['ok', 'result']);
    exactKeys(operation.result, ['operation', 'paths', 'snapshot']);

    exactKeys(await bridge.diff.getRepoRoot('/tmp/wp5a-fixture'), ['ok', 'root']);
    exactKeys(await bridge.diff.getFileDiff('/tmp/wp5a-fixture', 'src/fixture.ts', { mode: 'unstaged' }), ['ok', 'diff']);
    exactKeys(await makeFixture('diff-error').bridge.diff.getRepoCandidates(input), ['ok', 'error']);
});

test('browser states include every required field and no invalid null error', async () => {
    const { bridge } = makeFixture();
    const registered = await bridge.browser.registerWebview({ tabId: 'fixture-tab', webContentsId: 42 });
    exactKeys(registered, ['ok', 'state']);
    exactKeys(registered.state, [
        'tabId', 'webContentsId', 'url', 'title', 'loading', 'canGoBack', 'canGoForward',
        'crashed', 'sharedWithAgent',
    ]);
    assert.equal(registered.state.webContentsId, 42);
    assert.match(CONTRACT, /tabId: string;\s*webContentsId: number;/);
    assert.match(CONTRACT, /error\?: string;/);
    assert.equal('error' in registered.state, false);
    exactKeys(await bridge.browser.controlWebview({ kind: 'reload', tabId: 'fixture-tab' }), ['ok', 'state']);
    exactKeys(await bridge.browser.performWebviewAction({
        kind: 'setSharedWithAgent', tabId: 'fixture-tab', shared: true,
    }), ['ok', 'state']);
    exactKeys(await bridge.browser.getWebviewTabs(), ['ok', 'tabs']);
    exactKeys(await bridge.browser.unregisterWebview({ tabId: 'fixture-tab', webContentsId: 42 }), ['ok']);

    const crashed = makeFixture('crashed').bridge;
    const crashedState = await crashed.browser.registerWebview({ tabId: 'crashed-tab', webContentsId: 7 });
    assert.equal(typeof crashedState.state.error, 'string');
});

test('all fixture scenarios retain their intended success or failure state', async () => {
    for (const scenario of ['ready', 'restored', 'exited', 'create-error', 'list-error', 'loading', 'shared', 'crashed', 'diff-empty', 'diff-error']) {
        const { bridge, target } = makeFixture(scenario);
        assert.equal(typeof target['__wp5aArmBrowserWebview'], 'function');
        assert.equal(typeof target['__wp5aPushBrowserState'], 'function');
        assert.equal(typeof target['__wp5aKillTerminals'], 'function');

        const list = await bridge.terminal.list();
        assert.equal(list.ok, scenario !== 'list-error');
        const summary = await bridge.diff.getDiffSummary('/tmp/wp5a-fixture', { mode: 'unstaged' });
        assert.equal(summary.files.length, scenario === 'diff-empty' ? 0 : 1);
        const root = await bridge.diff.getRepoRoot('/tmp/wp5a-fixture');
        assert.equal(root.ok, scenario !== 'diff-error');
    }
});

test('browser-page helper hooks retain their callback and return signatures', async () => {
    const { bridge, target } = makeFixture('restored');
    let exit: [string, number | null] | null = null;
    bridge.terminal.onExit((id, code) => { exit = [id, code]; });
    assert.equal((target['__wp5aKillTerminals'] as (code?: number) => number)(), 1);
    assert.deepEqual(exit, ['fixture-1', 137]);

    let state: Record<string, unknown> | null = null;
    bridge.browser.onWebviewState((next) => { state = next; });
    assert.equal((target['__wp5aPushBrowserState'] as (tabId: string) => boolean)('fixture-tab'), true);
    assert.equal(state?.['tabId'], 'fixture-tab');
    assert.equal((target['__wp5aArmBrowserWebview'] as () => boolean)(), false);
});
