import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserOpenCommand } from '../../src/core/browser-open.js';
import {
    isHeadlessBrowserEnvironment,
    shouldOpenBrowserByDefault,
} from '../../src/core/browser-open-default.js';
import type { PlatformProbes } from '../../src/core/platform-kind.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

/**
 * Detection now consults the filesystem, so the "desktop Linux" rows must
 * inject inert probes. Without them a WSL CI runner would see the host's real
 * /proc markers and classify these fixtures as WSL.
 */
const inertProbes: PlatformProbes = {
    readText: () => null,
    exists: () => false,
    release: () => '',
};

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('dashboard browser opener uses Windows shell from WSL', () => {
    const command = browserOpenCommand('http://localhost:24576', 'linux', {
        WSL_DISTRO_NAME: 'Ubuntu',
    });

    assert.deepEqual(command, {
        command: 'cmd.exe',
        args: ['/c', 'start', '', 'http://localhost:24576'],
    });
});

test('dashboard browser opener keeps Linux xdg-open for desktop Linux', () => {
    const command = browserOpenCommand('http://localhost:24576', 'linux', {
        DISPLAY: ':0',
    }, inertProbes);

    assert.deepEqual(command, {
        command: 'xdg-open',
        args: ['http://localhost:24576'],
    });
});

test('a WSL kernel marker wins over a set DISPLAY', () => {
    const wslKernelProbes: PlatformProbes = {
        readText: (path) => (path === '/proc/version'
            ? 'Linux version 5.15.0-microsoft-standard-WSL2'
            : null),
        exists: () => false,
        release: () => '',
    };

    // Env carries no WSL variable at all: the kernel probe is the only signal.
    assert.equal(isHeadlessBrowserEnvironment({ DISPLAY: ':0' }, 'linux', wslKernelProbes), true);
    assert.deepEqual(
        browserOpenCommand('http://localhost:24576', 'linux', { DISPLAY: ':0' }, wslKernelProbes),
        { command: 'cmd.exe', args: ['/c', 'start', '', 'http://localhost:24576'] },
    );
});

test('dashboard does not auto-open by default in headless and WSL environments', () => {
    assert.equal(shouldOpenBrowserByDefault({ WSL_INTEROP: '/run/WSL/1_interop' }, 'linux', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({}, 'linux', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({ CI: 'true' }, 'darwin', inertProbes), false);
    assert.equal(shouldOpenBrowserByDefault({ DISPLAY: ':0' }, 'linux', inertProbes), true);
    assert.equal(isHeadlessBrowserEnvironment({ SSH_CONNECTION: 'host 22 host 12345' }, 'linux', inertProbes), true);
});

test('dashboard opener failure is logged without crashing the manager', () => {
    const browserOpen = read('src/core/browser-open.ts');

    assert.ok(browserOpen.includes("opener.on('error'"), 'opener spawn errors must be handled');
    assert.ok(browserOpen.includes('failed to open browser automatically'), 'failure must be visible to the user');
    assert.ok(browserOpen.includes('open manually'), 'manual URL fallback must be printed');
});
