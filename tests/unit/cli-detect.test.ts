import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    __setLookupExecForTests,
    buildCliDetectionEnv,
    describePathShape,
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

// ─── #471: a lookup tool that RAN and refused ───
//
// The reported failure was 'Command failed: where.exe codex' and nothing else.
// Exit status, the tool's own stderr, and the PATH it was asked about were all
// discarded, so the incident could not be narrowed past "resolution failed".

test('CD-SCAN-004: a tool that ran and refused reports status, stderr, and PATH shape', () => {
    __setLookupExecForTests(() => {
        const error = new Error('Command failed: where.exe codex') as Error & {
            status: number; stdout: string; stderr: string;
        };
        error.status = 2;
        error.stdout = '';
        error.stderr = 'ERROR: The system cannot find the path specified.\r\n';
        throw error;
    });
    try {
        const scan = listCliBinaryCandidates('codex', '/usr/bin:/bin');
        const scanError = scan.scanError || '';

        // The original message survives — existing consumers still match on it.
        assert.match(scanError, /Command failed: where\.exe codex/);
        // and the three facts #471 could not recover are now attached.
        assert.match(scanError, /The system cannot find the path specified/);
        assert.match(scanError, /exit 2/);
        assert.match(scanError, /PATH \d+ entries/);
    } finally {
        __setLookupExecForTests(null);
    }
});

test('CD-SCAN-005: a timeout is still reported as a timeout, not as a refusal', () => {
    // Node sets code ETIMEDOUT and signal SIGTERM when it kills on timeout.
    __setLookupExecForTests(() => {
        const error = new Error('spawnSync where.exe ETIMEDOUT') as Error & {
            code: string; signal: NodeJS.Signals; status: null;
        };
        error.code = 'ETIMEDOUT';
        error.signal = 'SIGTERM';
        error.status = null;
        throw error;
    });
    try {
        const scan = listCliBinaryCandidates('codex', '/usr/bin:/bin');
        assert.equal(scan.scanError, 'lookup timed out after 3000ms');
    } finally {
        __setLookupExecForTests(null);
    }
});

test('CD-SCAN-006: a refusal with no stderr still names its exit status', () => {
    __setLookupExecForTests(() => {
        const error = new Error('Command failed: which -a codex') as Error & {
            status: number; stdout: string; stderr: string;
        };
        error.status = 3;
        error.stdout = '';
        error.stderr = '';
        throw error;
    });
    try {
        const scan = listCliBinaryCandidates('codex', '/usr/bin:/bin');
        assert.match(scan.scanError || '', /exit 3/);
    } finally {
        __setLookupExecForTests(null);
    }
});

test('CD-SCAN-007: an exit-1 empty scan is still not a discovery failure', () => {
    // Guards the ordinary "not installed" path against the new detail branch.
    __setLookupExecForTests(() => {
        const error = new Error('Command failed: which -a codex') as Error & {
            status: number; stdout: string; stderr: string;
        };
        error.status = 1;
        error.stdout = '';
        error.stderr = '';
        throw error;
    });
    try {
        const scan = listCliBinaryCandidates('codex', '/usr/bin:/bin');
        assert.deepEqual(scan.candidates, []);
        assert.equal(scan.scanError, undefined);
    } finally {
        __setLookupExecForTests(null);
    }
});

test('describePathShape counts entries and flags POSIX-style ones on win32', () => {
    // The MSYS shape #471's process tree points at: a win32 lookup tool cannot
    // resolve '/c/...' or '/mingw64/bin', and the count alone would not say so.
    const msys = describePathShape('/mingw64/bin:/usr/bin:C:\\Users\\u\\AppData\\Roaming\\npm', 'win32');
    assert.match(msys, /3 entries/);
    assert.match(msys, /2 POSIX-style/);

    // A native win32 PATH carries no such warning.
    const native = describePathShape('C:\\WINDOWS\\System32;C:\\Users\\u\\AppData\\Roaming\\npm', 'win32');
    assert.match(native, /2 entries/);
    assert.doesNotMatch(native, /POSIX-style/);

    // POSIX paths are not "POSIX-style entries on a win32 PATH" — no flag there.
    assert.doesNotMatch(describePathShape('/usr/bin:/bin', 'darwin'), /POSIX-style/);
    assert.equal(describePathShape('', 'darwin'), 'PATH empty');
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
