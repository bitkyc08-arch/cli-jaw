// #299: every reboot the agent re-probed its host from zero, and one failed
// probe turned a working tool into "the tool does not exist".
//
// The behaviors worth pinning are the ones that make a record trustworthy:
// a failed scan must not erase what a previous scan proved, a Store alias must
// not be reported as Python, and an empty record must not emit a header with
// nothing under it.
import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    isWindowsStoreAlias,
    mergeHostToolchain,
    renderHostToolchainSection,
    scanHostToolchain,
    type HostToolEntry,
} from '../../src/memory/host-toolchain.ts';

const found = (name: string, p: string): HostToolEntry => ({ name, path: p, spawnable: true });
const missing = (name: string, note?: string): HostToolEntry =>
    ({ name, path: null, spawnable: false, ...(note ? { note } : {}) });

test('HTC-001: a failed scan keeps the last known good path', () => {
    // The whole point of the issue: machine facts that took real work to
    // establish must survive a probe that happens to fail.
    const real = path.join(os.tmpdir(), `jaw-htc-${Date.now()}`);
    fs.writeFileSync(real, '');
    try {
        const previous = mergeHostToolchain(null, [found('officecli', real)], '2026-01-01T00:00:00Z');
        const next = mergeHostToolchain(previous, [missing('officecli', 'lookup timed out')], '2026-01-02T00:00:00Z');
        const entry = next.tools.find((t) => t.name === 'officecli')!;
        assert.equal(entry.path, real, 'a timed-out lookup must not erase a proven path');
        assert.equal(entry.spawnable, true);
        assert.equal(next.lastAttemptAt, '2026-01-02T00:00:00Z');
        assert.equal(next.lastSuccessAt, '2026-01-01T00:00:00Z', 'success time must not advance on a failure');
    } finally { fs.rmSync(real, { force: true }); }
});

test('HTC-002: a remembered path is dropped once the file is gone', () => {
    // Stale-but-confident is its own failure mode; the tool was uninstalled.
    const gone = path.join(os.tmpdir(), `jaw-htc-missing-${Date.now()}`);
    const previous = mergeHostToolchain(null, [found('soffice', gone)], '2026-01-01T00:00:00Z');
    const next = mergeHostToolchain(previous, [missing('soffice')], '2026-01-02T00:00:00Z');
    assert.equal(next.tools.find((t) => t.name === 'soffice')!.path, null);
});

test('HTC-003: a fresh success advances lastSuccessAt', () => {
    const real = path.join(os.tmpdir(), `jaw-htc-ok-${Date.now()}`);
    fs.writeFileSync(real, '');
    try {
        const record = mergeHostToolchain(null, [found('rg', real)], '2026-02-02T00:00:00Z');
        assert.equal(record.lastSuccessAt, '2026-02-02T00:00:00Z');
    } finally { fs.rmSync(real, { force: true }); }
});

test('HTC-004: the Store alias directory is matched exactly, not by substring', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } as NodeJS.ProcessEnv;
    const alias = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
    const unrelated = 'C:\\dev\\MyWindowsAppsProject\\python.exe';
    const nested = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\sub\\python.exe';
    if (process.platform === 'win32') {
        assert.equal(isWindowsStoreAlias(alias, env), true);
        assert.equal(isWindowsStoreAlias(unrelated, env), false, 'a name containing WindowsApps is not the Store dir');
        assert.equal(isWindowsStoreAlias(nested, env), false, 'only the alias directory itself counts');
    } else {
        // The Store alias problem does not exist off Windows; the guard must
        // not fire and accidentally hide a real python.
        assert.equal(isWindowsStoreAlias(alias, env), false);
    }
});

test('HTC-005: an empty or all-missing record renders nothing', () => {
    // A header with no paths under it is noise in a 64 KB file.
    assert.equal(renderHostToolchainSection(null), '');
    assert.equal(renderHostToolchainSection({ tools: [], lastAttemptAt: 'x', lastSuccessAt: null }), '');
    assert.equal(
        renderHostToolchainSection({ tools: [missing('python')], lastAttemptAt: 'x', lastSuccessAt: null }),
        '',
        'nothing resolved means there is nothing worth injecting',
    );
});

test('HTC-006: a populated record publishes absolute paths and a timestamp', () => {
    // The issue complained that AGENTS.md mentioned officecli three times and
    // never once said where it is.
    const section = renderHostToolchainSection({
        tools: [found('officecli', '/usr/local/bin/officecli'), missing('python', 'Store alias ignored')],
        lastAttemptAt: '2026-03-03T00:00:00Z',
        lastSuccessAt: '2026-03-03T00:00:00Z',
    });
    assert.match(section, /## Host toolchain/);
    assert.match(section, /- officecli: \/usr\/local\/bin\/officecli/);
    assert.match(section, /- python: not found — Store alias ignored/);
    assert.match(section, /verified_at: 2026-03-03T00:00:00Z/);
});

test('HTC-007: scanning returns an entry per tool and never throws', () => {
    // Runs against the real host: the contract is shape and totality, not
    // which tools this particular machine happens to have.
    const scanned = scanHostToolchain(['rg', 'definitely-not-a-real-binary-xyz']);
    assert.equal(scanned.length, 2);
    const bogus = scanned.find((t) => t.name === 'definitely-not-a-real-binary-xyz')!;
    assert.equal(bogus.spawnable, false);
    assert.equal(bogus.path, null);
    for (const entry of scanned) {
        if (entry.spawnable) assert.ok(path.isAbsolute(entry.path!), `${entry.name} must record an absolute path`);
    }
});
