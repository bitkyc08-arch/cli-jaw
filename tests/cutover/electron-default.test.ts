import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliFlags } from '../../electron/src/main/lib/cli-flags.ts';
import {
    buildImplicitManagerUrl,
    resolveManagerRouteUrl,
} from '../../electron/src/main/lib/manager-url.ts';

function withoutManagerEnvironment<T>(run: () => T): T {
    const previousUrl = process.env.JAW_MANAGER_URL;
    const previousPort = process.env.JAW_MANAGER_PORT;
    delete process.env.JAW_MANAGER_URL;
    delete process.env.JAW_MANAGER_PORT;
    try {
        return run();
    } finally {
        if (previousUrl === undefined) delete process.env.JAW_MANAGER_URL;
        else process.env.JAW_MANAGER_URL = previousUrl;
        if (previousPort === undefined) delete process.env.JAW_MANAGER_PORT;
        else process.env.JAW_MANAGER_PORT = previousPort;
    }
}

test('implicit Electron argv selects dashboard2 and preserves it after occupied-port reselection', () => {
    withoutManagerEnvironment(() => {
        const flags = parseCliFlags([], 24577);
        assert.equal(new URL(flags.managerUrl).pathname, '/dashboard2/');
        assert.equal(flags.managerUrlExplicit, false);

        const reselectedUrl = buildImplicitManagerUrl(flags.port + 1);
        assert.equal(new URL(reselectedUrl).pathname, new URL(flags.managerUrl).pathname);
    });
});

test('JAW_MANAGER_URL remains explicit and preserves both custom and root paths', () => {
    withoutManagerEnvironment(() => {
        for (const managerUrl of [
            'http://127.0.0.1:24577/custom/?qa=cutover',
            'http://127.0.0.1:24577/',
        ]) {
            process.env.JAW_MANAGER_URL = managerUrl;
            const flags = parseCliFlags([], 24577);
            assert.equal(flags.managerUrl, managerUrl);
            assert.equal(flags.managerUrlExplicit, true);
        }
    });
});

test('tray reminders route remains below the dashboard2 manager base', () => {
    const trayUrl = resolveManagerRouteUrl(
        buildImplicitManagerUrl(24577),
        '/?sidebar=reminders',
    );
    assert.equal(trayUrl, 'http://127.0.0.1:24577/dashboard2/?sidebar=reminders');
});
