import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    __setLookupExecForTests,
    buildCliDetectionEnv,
    formatCliUnavailableMessage,
    isSpawnableCliFile,
    listCliBinaryCandidates,
    prioritizeCliCandidates,
    readProcessPath,
    selectSpawnableCliPath,
} from '../../src/core/cli-detect.ts';

function writeExecutable(dir: string, name: string, content: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    fs.chmodSync(filePath, 0o755);
    return filePath;
}

test('isSpawnableCliFile rejects executable text stubs without shebang', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-cli-detect-'));
    const stub = writeExecutable(dir, 'claude-broken', 'echo "Error: claude native binary not installed." >&2\n');

    const result = isSpawnableCliFile(stub, 'darwin');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'text file without shebang');
});

test('selectSpawnableCliPath skips broken PATH candidates and chooses a later runnable script', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-cli-detect-'));
    const broken = writeExecutable(dir, 'claude-broken', 'echo "Error: claude native binary not installed." >&2\n');
    const working = writeExecutable(dir, 'claude-working', '#!/usr/bin/env sh\necho "2.1.126 (Claude Code)"\n');

    const result = selectSpawnableCliPath([broken, working], 'darwin');

    assert.equal(result.available, true);
    assert.equal(result.path, working);
    assert.deepEqual(result.rejected, [{ path: broken, reason: 'text file without shebang' }]);
});

test('selectSpawnableCliPath reports rejected candidates when none are spawnable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-cli-detect-'));
    const broken = writeExecutable(dir, 'claude-broken', 'echo "broken"\n');

    const result = selectSpawnableCliPath([broken], 'darwin');

    assert.equal(result.available, false);
    assert.equal(result.path, null);
    assert.deepEqual(result.rejected, [{ path: broken, reason: 'text file without shebang' }]);
});

test('readProcessPath accepts PATH, Path, and path keys in priority order', () => {
    assert.equal(readProcessPath({ PATH: '/tmp/upper', Path: '/tmp/title', path: '/tmp/lower' }), '/tmp/upper');
    assert.equal(readProcessPath({ Path: '/tmp/title', path: '/tmp/lower' }), '/tmp/title');
    assert.equal(readProcessPath({ path: '/tmp/lower' }), '/tmp/lower');
    assert.equal(readProcessPath({}), '');
});

test('buildCliDetectionEnv normalizes duplicate PATH casing', () => {
    const env = buildCliDetectionEnv('/tmp/jaw-path', {
        PATH: '/tmp/upper',
        Path: '/tmp/title',
        path: '/tmp/lower',
    });
    const key = process.platform === 'win32' ? 'Path' : 'PATH';
    const otherKeys = process.platform === 'win32' ? ['PATH', 'path'] : ['Path', 'path'];

    assert.ok(env[key]?.includes('/tmp/jaw-path'));
    for (const otherKey of otherKeys) assert.equal(env[otherKey], undefined);
});

test('listCliBinaryCandidates returns candidates with spawnability state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-cli-detect-list-'));
    const commandName = 'jaw-test-cli';
    const fileName = process.platform === 'win32' ? `${commandName}.cmd` : commandName;
    const content = process.platform === 'win32'
        ? '@echo off\r\necho ok\r\n'
        : '#!/usr/bin/env sh\necho ok\n';
    const cliPath = writeExecutable(dir, fileName, content);
    const result = listCliBinaryCandidates(commandName, `${dir}${path.delimiter}${readProcessPath()}`);

    assert.equal(result.candidates.some((candidate) => candidate.path === cliPath && candidate.spawnable), true);
});

test('CD-SCAN-001: a missing lookup tool is reported as a scan error, not as absence', () => {
    __setLookupExecForTests(() => {
        const error = new Error('spawn lookup ENOENT') as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
    });
    try {
        const scan = listCliBinaryCandidates('codex-app', '/missing');
        assert.deepEqual(scan.candidates, []);
        assert.match(scan.scanError || '', /lookup tool '.*' not found/);
    } finally {
        __setLookupExecForTests(null);
    }
});

test('CD-SCAN-002: a genuine no-match stays a plain empty scan', () => {
    __setLookupExecForTests(() => {
        const error = new Error('no matches') as Error & { status: number; stdout: string };
        error.status = 1;
        error.stdout = '';
        throw error;
    });
    try {
        const scan = listCliBinaryCandidates('codex-app', '/empty');
        assert.deepEqual(scan.candidates, []);
        assert.equal(scan.scanError, undefined);
    } finally {
        __setLookupExecForTests(null);
    }
});

test('CD-SCAN-003: the unavailable message names the scan error', () => {
    const message = formatCliUnavailableMessage('codex-app', {
        available: false,
        path: null,
        scanError: 'lookup timed out after 3000ms',
    });

    assert.match(message, /could not be resolved: lookup timed out after 3000ms/);
});

test('prioritizeCliCandidates moves bun shims behind managed node bins for claude', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-cli-detect-home-'));
    const bunClaude = path.join(home, '.bun', 'bin', 'claude');
    const nvmClaude = path.join(home, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'claude');
    const otherClaude = path.join('/opt/homebrew/bin', 'claude');

    const result = prioritizeCliCandidates('claude', [bunClaude, otherClaude, nvmClaude], home);

    assert.deepEqual(result, [nvmClaude, otherClaude, bunClaude]);
});

test('prioritizeCliCandidates moves native Claude before nvm/npm and bun shims', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-cli-detect-home-'));
    const nvmClaude = path.join(home, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', 'claude');
    const nativeClaude = path.join(home, '.local', 'bin', 'claude');
    const bunClaude = path.join(home, '.bun', 'bin', 'claude');

    const result = prioritizeCliCandidates('claude', [nvmClaude, nativeClaude, bunClaude], home);

    assert.deepEqual(result, [nativeClaude, nvmClaude, bunClaude]);
});

test('prioritizeCliCandidates moves bun shims behind managed node bins for npm-managed agent CLIs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-cli-detect-home-'));
    for (const cli of ['codex', 'copilot', 'opencode']) {
        const bunPath = path.join(home, '.bun', 'bin', cli);
        const nvmPath = path.join(home, '.nvm', 'versions', 'node', 'v22.18.0', 'bin', cli);
        const result = prioritizeCliCandidates(cli, [bunPath, nvmPath], home);
        assert.deepEqual(result, [nvmPath, bunPath], `${cli} should prefer npm-managed binary over bun shim`);
    }
});
