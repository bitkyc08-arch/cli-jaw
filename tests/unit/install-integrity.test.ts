/**
 * install-integrity contract — 260804 install hardening.
 *
 * npm >= 12 blocks unreviewed dependency lifecycle scripts, so a global
 * install can "succeed" while our postinstall never ran. These tests pin the
 * classification (blocked/safe-mode/completed/failed/stale), the split
 * install-state vs setup-state model, and the exact recovery command text —
 * including the npm/cli#9835 regression (npm's own printed hint omits the
 * package argument and fails with ENOENT).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    detectPackageManager,
    checkPsExecutionPolicy,
    formatIntegrityReport,
    formatRecoveryCommands,
    inspectInstallIntegrity,
    readInstallState,
    readSetupState,
    writeSetupState,
    INSTALL_STATE_FILE,
    SETUP_STATE_FILE,
    type InstallIntegrity,
} from '../../src/core/install-integrity.js';

const PKG_VERSION = '9.9.9';

function makeRoot(receipt?: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-integrity-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cli-jaw', version: PKG_VERSION }));
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    if (receipt) {
        fs.writeFileSync(path.join(dir, INSTALL_STATE_FILE), JSON.stringify(receipt));
    }
    return dir;
}

function makeHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-home-'));
}

test('completed receipt with current version → completed, no warning path', () => {
    const root = makeRoot({ schema: 1, state: 'completed', packageVersion: PKG_VERSION });
    const integrity = inspectInstallIntegrity(root, makeHome());
    assert.equal(integrity.installScriptState, 'completed');
});

test('no receipt and no home marker → blocked with allow-scripts recovery', () => {
    const root = makeRoot();
    const integrity = inspectInstallIntegrity(root, makeHome());
    assert.equal(integrity.installScriptState, 'blocked');
    assert.equal(integrity.userSetupDone, false);
    const report = formatIntegrityReport(integrity);
    assert.match(report, /--allow-scripts=cli-jaw/);
});

test('missing receipt classifies only a .git-marked development clone', () => {
    const root = makeRoot();
    assert.equal(inspectInstallIntegrity(root, makeHome(), {
        existsSync: file => file === path.join(root, '.git'),
    }).installScriptState, 'dev-clone');
    assert.equal(inspectInstallIntegrity(root, makeHome(), {
        existsSync: () => false,
    }).installScriptState, 'blocked');
});

test('receipt states win over the development-clone marker', () => {
    const completed = makeRoot({ schema: 1, state: 'completed', packageVersion: PKG_VERSION });
    const stale = makeRoot({ schema: 1, state: 'completed', packageVersion: '0.0.1' });
    const marker = { existsSync: () => true };
    assert.equal(inspectInstallIntegrity(completed, makeHome(), marker).installScriptState, 'completed');
    assert.equal(inspectInstallIntegrity(stale, makeHome(), marker).installScriptState, 'stale');
});

test('receipt from a different version → stale (upgrade never hidden)', () => {
    const root = makeRoot({ schema: 1, state: 'completed', packageVersion: '0.0.1' });
    const integrity = inspectInstallIntegrity(root, makeHome());
    assert.equal(integrity.installScriptState, 'stale');
});

test('home marker with current version clears the user-setup gate', () => {
    const root = makeRoot();
    const home = makeHome();
    writeSetupState(home, PKG_VERSION);
    const integrity = inspectInstallIntegrity(root, home);
    assert.equal(integrity.installScriptState, 'blocked');
    assert.equal(integrity.userSetupDone, true);
});

test('home marker from an older version does NOT clear the gate', () => {
    const root = makeRoot();
    const home = makeHome();
    writeSetupState(home, '0.0.1');
    const integrity = inspectInstallIntegrity(root, home);
    assert.equal(integrity.userSetupDone, false);
});

test('sidecar receipt (state completed) passes like any completed receipt', () => {
    const root = makeRoot({ schema: 1, state: 'completed', sidecar: true, packageVersion: PKG_VERSION });
    const integrity = inspectInstallIntegrity(root, makeHome());
    assert.equal(integrity.installScriptState, 'completed');
});

test('failed receipt is reported as failed, not blocked', () => {
    const root = makeRoot({ schema: 1, state: 'failed', packageVersion: PKG_VERSION, error: 'boom' });
    const integrity = inspectInstallIntegrity(root, makeHome());
    assert.equal(integrity.installScriptState, 'failed');
    assert.match(formatIntegrityReport(integrity), /jaw doctor/);
});

test('safe-mode receipt points at jaw init, not reinstall', () => {
    const root = makeRoot({ schema: 1, state: 'safe-mode', packageVersion: PKG_VERSION });
    const integrity = inspectInstallIntegrity(root, makeHome());
    assert.equal(integrity.installScriptState, 'safe-mode');
    assert.match(formatIntegrityReport(integrity), /jaw init/);
});

function integrityFor(pm: InstallIntegrity['packageManager']): InstallIntegrity {
    return {
        installScriptState: 'blocked',
        userSetupDone: false,
        nativeLoadable: false,
        packageManager: pm,
        installRoot: '/tmp/x',
        writableInstallTree: false,
        scriptDependents: ['cli-jaw'],
    };
}

test('npm recovery keeps the package argument (npm/cli#9835 regression)', () => {
    const commands = formatRecoveryCommands(integrityFor('npm'));
    assert.ok(commands.some(c => c === 'npm install -g cli-jaw --allow-scripts=cli-jaw'),
        `expected the package-argument form, got: ${commands.join(' | ')}`);
    // The broken npm-printed form must never appear.
    assert.ok(!commands.some(c => /npm install -g --allow-scripts/.test(c)),
        'must not echo npm\'s package-less remediation');
});

test('win32 npm recovery includes PowerShell shim guidance', () => {
    const commands = formatRecoveryCommands(integrityFor('npm'), 'win32');
    assert.ok(commands.some(command => command.includes('jaw.ps1')));
    assert.ok(commands.some(command => command.includes('jaw.cmd')));
    assert.ok(commands.some(command => command.includes('dist\\bin\\cli-jaw.js')));
});

test('PowerShell execution policy maps safe and blocked values', () => {
    for (const policy of ['RemoteSigned', 'Bypass', 'Unrestricted']) {
        assert.deepEqual(checkPsExecutionPolicy({ platform: 'win32', runPolicy: () => policy }), {
            state: 'ok', policy,
        });
    }
    for (const policy of ['Restricted', 'AllSigned', 'Undefined']) {
        const result = checkPsExecutionPolicy({ platform: 'win32', runPolicy: () => policy });
        assert.equal(result.state, 'warn');
        assert.match(result.guidance || '', /CurrentUser RemoteSigned/);
        assert.match(result.guidance || '', /jaw\.cmd/);
        assert.match(result.guidance || '', /node <prefix>/);
    }
});

test('PowerShell execution policy skips non-Windows and warns with default on probe failure', () => {
    let called = false;
    assert.deepEqual(checkPsExecutionPolicy({
        platform: 'linux',
        runPolicy: () => { called = true; return 'Restricted'; },
    }), { state: 'skipped' });
    assert.equal(called, false);
    const empty = checkPsExecutionPolicy({ platform: 'win32', runPolicy: () => '', runRegQuery: () => '' });
    assert.strictEqual(empty.state, 'warn');
    assert.match(empty.policy || '', /Restricted/);
    const thrown = checkPsExecutionPolicy({
        platform: 'win32',
        runPolicy: () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
        runRegQuery: () => { throw new Error('reg missing'); },
    });
    assert.strictEqual(thrown.state, 'warn');
});

test('dangerous wildcards are never suggested anywhere', () => {
    for (const pm of ['npm', 'pnpm', 'bun', 'unknown'] as const) {
        const all = formatRecoveryCommands(integrityFor(pm)).join('\n')
            + formatIntegrityReport(integrityFor(pm));
        assert.ok(!all.includes('--dangerously-allow-all-scripts'), `${pm}: dangerously-allow-all leaked`);
        assert.ok(!all.includes('allow-scripts=true'), `${pm}: fake wildcard leaked`);
    }
});

test('pnpm recovery prints the pnpm-11 global form first', () => {
    const commands = formatRecoveryCommands(integrityFor('pnpm'));
    assert.match(commands[0]!, /pnpm add -g --allow-build=cli-jaw cli-jaw/);
    assert.ok(commands.some(c => c.includes('approve-builds -g')), 'pnpm <= 10 fallback missing');
});

test('bun recovery uses add -g --trust (bun pm trust cannot fix a global install)', () => {
    const commands = formatRecoveryCommands(integrityFor('bun'));
    assert.deepEqual(commands, ['bun add -g --trust cli-jaw']);
});

test('package manager detection: path signals without user agent', () => {
    assert.equal(detectPackageManager('/Users/x/.bun/install/global/node_modules/cli-jaw', {}), 'bun');
    assert.equal(detectPackageManager('/Users/x/Library/pnpm/global/5/node_modules/cli-jaw', {}), 'pnpm');
    assert.equal(detectPackageManager('/usr/local/lib/node_modules/cli-jaw', {}), 'npm');
});

test('package manager detection: user agent wins while the manager runs us', () => {
    assert.equal(detectPackageManager('/usr/local/lib/node_modules/cli-jaw', { npm_config_user_agent: 'pnpm/11.0.0' }), 'pnpm');
    assert.equal(detectPackageManager('/usr/local/lib/node_modules/cli-jaw', { npm_config_user_agent: 'bun/1.3.0' }), 'bun');
});

test('postinstall-guard receipt writer satisfies the reader schema', () => {
    // Field-set contract between the CJS writer (scripts/postinstall-guard.cjs)
    // and the TS reader — validated per file type, not across file types.
    const root = makeRoot();
    const guardSource = fs.readFileSync(
        path.join(process.cwd(), 'scripts', 'postinstall-guard.cjs'), 'utf8');
    for (const field of ['schema', 'state', 'packageVersion', 'ranAt']) {
        assert.ok(guardSource.includes(field), `guard writer missing reader field: ${field}`);
    }
    // And a receipt of the guard's shape actually round-trips through the reader.
    fs.writeFileSync(path.join(root, INSTALL_STATE_FILE), JSON.stringify({
        schema: 1, state: 'completed', packageVersion: PKG_VERSION,
        ranAt: new Date().toISOString(), node: process.version,
        platform: process.platform, arch: process.arch,
    }));
    const receipt = readInstallState(root);
    assert.equal(receipt?.state, 'completed');
    assert.equal(receipt?.packageVersion, PKG_VERSION);
});

test('writeSetupState output satisfies the setup-state reader schema', () => {
    const home = makeHome();
    writeSetupState(home, PKG_VERSION);
    const marker = readSetupState(home);
    assert.equal(marker?.schema, 1);
    assert.equal(marker?.packageVersion, PKG_VERSION);
    assert.ok(marker?.doneAt, 'doneAt missing');
    assert.ok(fs.existsSync(path.join(home, SETUP_STATE_FILE)));
});

test('read-only node_modules → writableInstallTree false and report avoids rebuild advice', () => {
    if (process.platform === 'win32') return; // chmod semantics differ
    const root = makeRoot();
    fs.chmodSync(path.join(root, 'node_modules'), 0o500);
    try {
        const integrity = inspectInstallIntegrity(root, makeHome());
        assert.equal(integrity.writableInstallTree, false);
        const report = formatIntegrityReport(integrity);
        assert.ok(!/npm rebuild/.test(report), 'must not recommend rebuild on a read-only tree');
        assert.match(report, /--allow-scripts=cli-jaw/);
    } finally {
        fs.chmodSync(path.join(root, 'node_modules'), 0o755);
    }
});

test('ps policy falls back to registry when the PS probe fails', () => {
    const result = checkPsExecutionPolicy({
        platform: 'win32',
        runPolicy: () => { throw new Error('module load failed'); },
        runRegQuery: () => 'Restricted',
    });
    assert.strictEqual(result.state, 'warn');
    assert.strictEqual(result.policy, 'Restricted');
});

test('ps policy warns with the Windows default when both probes fail', () => {
    const result = checkPsExecutionPolicy({
        platform: 'win32',
        runPolicy: () => { throw new Error('x'); },
        runRegQuery: () => { throw new Error('y'); },
    });
    assert.strictEqual(result.state, 'warn');
    assert.match(result.policy || '', /Restricted/);
});
