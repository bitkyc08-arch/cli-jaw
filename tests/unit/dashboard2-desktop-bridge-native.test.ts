import test from 'node:test';
import assert from 'node:assert/strict';

// Native call smoke (089.01 §3.4): a fake preload is installed on globalThis.window and
// every capability surface is exercised through context.native, proving argument,
// return-value, and unsubscribe passthrough without an Electron runtime.

interface Call { method: string; args: unknown[] }

function makeFakePreload(calls: Call[]): Record<string, unknown> {
    const record = (method: string, result: unknown) => (...args: unknown[]) => {
        calls.push({ method, args });
        return result;
    };
    const unsubscribe = (method: string) => (...args: unknown[]) => {
        calls.push({ method, args });
        return () => { calls.push({ method: `${method}:unsubscribe`, args: [] }); };
    };
    return {
        identify: () => ({ name: 'cli-jaw-desktop', electron: true, header: 'x-cli-jaw-electron', token: 'tok' }),
        getHomePath: () => '/home/fake',
        terminal: {
            list: record('terminal.list', Promise.resolve({ ok: true, sessions: [] })),
            create: record('terminal.create', Promise.resolve({ ok: true, id: 't1' })),
            write: record('terminal.write', Promise.resolve()),
            resize: record('terminal.resize', Promise.resolve()),
            kill: record('terminal.kill', Promise.resolve()),
            onData: unsubscribe('terminal.onData'),
            onExit: unsubscribe('terminal.onExit'),
        },
        folder: {
            getDefaultRoot: record('folder.getDefaultRoot', Promise.resolve({ ok: true, path: '/root' })),
            pickFolder: record('folder.pickFolder', Promise.resolve({ ok: true })),
            pickFile: record('folder.pickFile', Promise.resolve({ ok: true })),
            authorizeRoot: record('folder.authorizeRoot', Promise.resolve({ ok: true })),
            registerGitWorktreeRoot: record('folder.registerGitWorktreeRoot', Promise.resolve({ ok: true })),
            listDir: record('folder.listDir', Promise.resolve({ ok: true, entries: [] })),
            readFile: record('folder.readFile', Promise.resolve({ ok: true, content: '' })),
            movePath: record('folder.movePath', Promise.resolve({ ok: true })),
            createFile: record('folder.createFile', Promise.resolve({ ok: true })),
            createFolder: record('folder.createFolder', Promise.resolve({ ok: true })),
            renamePath: record('folder.renamePath', Promise.resolve({ ok: true })),
            revealPath: record('folder.revealPath', Promise.resolve({ ok: true })),
            watchDir: record('folder.watchDir', Promise.resolve({ ok: true })),
            unwatchDir: record('folder.unwatchDir', Promise.resolve({ ok: true })),
            onDirChange: unsubscribe('folder.onDirChange'),
        },
        dragDrop: {
            resolveDroppedItems: record('dragDrop.resolveDroppedItems', Promise.resolve({ ok: true, entries: [] })),
        },
        clipboard: { writeText: record('clipboard.writeText', Promise.resolve({ ok: true })) },
        diff: {
            getRepoRoot: record('diff.getRepoRoot', Promise.resolve({ ok: true })),
            getRepoCandidates: record('diff.getRepoCandidates', Promise.resolve({ ok: true })),
            getScmSnapshot: record('diff.getScmSnapshot', Promise.resolve({ ok: true })),
            runScmOperation: record('diff.runScmOperation', Promise.resolve({ ok: true })),
            getDiffSummary: record('diff.getDiffSummary', Promise.resolve({ ok: true })),
            getFileDiff: record('diff.getFileDiff', Promise.resolve({ ok: true })),
        },
        git: {
            getStatusMap: record('git.getStatusMap', Promise.resolve({ ok: true })),
            getWorktrees: record('git.getWorktrees', Promise.resolve({ ok: true })),
            previewWorktreeOperation: record('git.previewWorktreeOperation', Promise.resolve({ ok: true })),
            runWorktreeOperation: record('git.runWorktreeOperation', Promise.resolve({ ok: true })),
        },
        browser: {
            onOpenUrl: unsubscribe('browser.onOpenUrl'),
            registerWebview: record('browser.registerWebview', Promise.resolve({ ok: true })),
            unregisterWebview: record('browser.unregisterWebview', Promise.resolve({ ok: true })),
            controlWebview: record('browser.controlWebview', Promise.resolve({ ok: true })),
            performWebviewAction: record('browser.performWebviewAction', Promise.resolve({ ok: true })),
            getWebviewTabs: record('browser.getWebviewTabs', Promise.resolve({ ok: true, tabs: [] })),
            onWebviewState: unsubscribe('browser.onWebviewState'),
            onElementPicked: unsubscribe('browser.onElementPicked'),
        },
        shortcuts: { onAction: unsubscribe('shortcuts.onAction') },
        trayReminders: {
            popUpMenu: record('trayReminders.popUpMenu', undefined),
            openDashboard: record('trayReminders.openDashboard', undefined),
        },
        reloadWindow: record('reloadWindow', Promise.resolve()),
        hardReloadWindow: record('hardReloadWindow', Promise.resolve()),
    };
}

test('native adapters pass calls, args, and unsubscribes through to the preload', async () => {
    const calls: Call[] = [];
    (globalThis as Record<string, unknown>)['window'] = { cliJawDesktop: makeFakePreload(calls) };
    try {
        const { createDesktopBridgeValue } = await import(
            '../../public/dashboard2/src/providers/desktop-bridge-provider.tsx'
        );
        const bridge = createDesktopBridgeValue();

        for (const [label, surface] of Object.entries({
            terminal: bridge.terminal,
            folder: bridge.filesystem.folder,
            dragDrop: bridge.filesystem.dragDrop,
            diff: bridge.sourceControl.diff,
            git: bridge.sourceControl.git,
            browser: bridge.browser,
            shortcuts: bridge.shell.shortcuts,
            tray: bridge.shell.tray,
        })) {
            assert.equal(surface.nativeAvailable, true, `${label} must be available`);
            assert.equal(surface.nativeWired, true, `${label} must be wired`);
            assert.notEqual(surface.native, null, `${label} native must be injected`);
        }

        const created = await bridge.terminal.native!.create({ cols: 80, rows: 24 });
        assert.deepEqual(created, { ok: true, id: 't1' });
        const offData = bridge.terminal.native!.onData(() => {});
        offData();

        const root = await bridge.filesystem.folder.native!.getDefaultRoot();
        assert.deepEqual(root, { ok: true, path: '/root' });
        await bridge.filesystem.folder.native!.listDir('/root');
        await bridge.filesystem.dragDrop.native!.resolveDroppedItems([]);
        await bridge.sourceControl.diff.native!.getRepoRoot('/repo');
        await bridge.sourceControl.git.native!.getStatusMap('/repo');
        await bridge.browser.native!.getWebviewTabs();
        const offAction = bridge.shell.shortcuts.native!.onAction(() => {});
        offAction();
        bridge.shell.tray.native!.openDashboard();

        const methods = calls.map((call) => call.method);
        for (const expected of [
            'terminal.create', 'terminal.onData', 'terminal.onData:unsubscribe',
            'folder.getDefaultRoot', 'folder.listDir', 'dragDrop.resolveDroppedItems',
            'diff.getRepoRoot', 'git.getStatusMap', 'browser.getWebviewTabs',
            'shortcuts.onAction', 'shortcuts.onAction:unsubscribe', 'trayReminders.openDashboard',
        ]) {
            assert.ok(methods.includes(expected), `expected preload call ${expected}`);
        }

        const createCall = calls.find((call) => call.method === 'terminal.create');
        assert.deepEqual(createCall?.args, [{ cols: 80, rows: 24 }], 'args must pass through unchanged');
        const listDirCall = calls.find((call) => call.method === 'folder.listDir');
        assert.deepEqual(listDirCall?.args, ['/root']);

        assert.ok(!('controlWebview' in (bridge.browser.native as object)), 'browser adapter must omit controlWebview');
    } finally {
        delete (globalThis as Record<string, unknown>)['window'];
    }
});

test('partial preload surfaces stay unwired', async () => {
    const calls: Call[] = [];
    const fake = makeFakePreload(calls) as Record<string, Record<string, unknown>>;
    delete fake['terminal']!['kill'];
    delete fake['browser']!['performWebviewAction'];
    (globalThis as Record<string, unknown>)['window'] = { cliJawDesktop: fake };
    try {
        const { createDesktopBridgeValue } = await import(
            '../../public/dashboard2/src/providers/desktop-bridge-provider.tsx'
        );
        const bridge = createDesktopBridgeValue();
        assert.equal(bridge.terminal.nativeAvailable, false);
        assert.equal(bridge.terminal.nativeWired, false);
        assert.equal(bridge.terminal.native, null);
        assert.equal(bridge.browser.nativeAvailable, false);
        assert.equal(bridge.browser.native, null);
        assert.equal(bridge.filesystem.folder.nativeWired, true, 'unrelated surfaces stay wired');
    } finally {
        delete (globalThis as Record<string, unknown>)['window'];
    }
});
