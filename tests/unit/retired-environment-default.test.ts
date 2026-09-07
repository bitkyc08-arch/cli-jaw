import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';

const home = mkdtempSync(join(tmpdir(), 'cli-jaw-retired-env-'));
const previousHome = process.env['CLI_JAW_HOME'];
const previousDefault = process.env['CLI_JAW_DEFAULT_CLI'];
process.env['CLI_JAW_HOME'] = home;
process.env['CLI_JAW_DEFAULT_CLI'] = 'jwc';
after(() => {
    if (previousHome === undefined) delete process.env['CLI_JAW_HOME'];
    else process.env['CLI_JAW_HOME'] = previousHome;
    if (previousDefault === undefined) delete process.env['CLI_JAW_DEFAULT_CLI'];
    else process.env['CLI_JAW_DEFAULT_CLI'] = previousDefault;
    rmSync(home, { recursive: true, force: true });
});

let pickerCalls = 0, processCalls = 0;
mock.module('../../src/cli/readiness.js', { namedExports: {
    pickFirstReadyCli: () => { pickerCalls++; return 'pi'; },
} });
const forbiddenProcess = () => { processCalls++; assert.fail('retired default must not launch a provider or probe'); };
const processSeams = Object.fromEntries(
    ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name => [name, forbiddenProcess]),
);
mock.module('node:child_process', {
    namedExports: { ...childProcess, ...processSeams }, defaultExport: { ...childProcess, ...processSeams },
});
const config = await import('../../src/core/config.ts');
const { DEFAULT_CLI, CLI_KEYS } = await import('../../src/cli/registry.ts');

test('new home retains retired environment default through boot, reload and admission without readiness', async t => {
    assert.equal(config.isEstablishedHome(), false);
    assert.equal(DEFAULT_CLI, 'codex-app');
    assert.equal(CLI_KEYS.some(cli => String(cli) === 'jwc'), false);
    assert.equal(config.DEFAULT_SETTINGS.cli, 'jwc');
    const loaded = config.loadSettings();
    assert.equal(loaded.cli, 'jwc');
    assert.equal(loaded.runtimeSelectionDiagnostic, 'retired_runtime:jwc');
    assert.equal(config.isSettingsPersistenceBlocked(), false);
    assert.equal(pickerCalls, 0);
    const persisted = JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8'));
    assert.equal(persisted.cli, 'jwc');
    assert.equal(Object.hasOwn(persisted, 'runtimeSelectionDiagnostic'), false);
    assert.equal(readdirSync(home).some(name => name.includes('.corrupt-')), false);
    assert.equal(config.loadSettings().runtimeSelectionDiagnostic, 'retired_runtime:jwc');

    t.mock.method(globalThis, 'fetch', async () => assert.fail('unexpected provider request'));
    const { spawnAgent, activeMainProcesses } = await import('../../src/agent/spawn.ts');
    const run = spawnAgent('do not silently replace the configured runtime', {
        scopeKey: 'retired-env-default', chatSessionId: 'retired-env-chat',
    });
    assert.equal(run.child, null);
    const result = await run.promise;
    assert.equal(result.code, 78);
    assert.match(result.text, /^retired_runtime:jwc:/);
    assert.equal(activeMainProcesses.size, 0);
    assert.equal(pickerCalls, 0);
    assert.equal(processCalls, 0);
});

test('explicit supported saved selection wins over retired environment default', () => {
    const saved = JSON.parse(readFileSync(config.SETTINGS_PATH, 'utf8'));
    writeFileSync(config.SETTINGS_PATH, JSON.stringify({ ...saved, cli: 'pi',
        perCli: { ...saved.perCli, pi: { model: 'saved-model', effort: 'high' } } }));
    const loaded = config.loadSettings();
    assert.equal(loaded.cli, 'pi');
    assert.equal(loaded.runtimeSelectionDiagnostic, null);
    assert.equal(loaded.perCli.pi.model, 'saved-model');
    assert.equal(pickerCalls, 0);
    assert.equal(processCalls, 0);
});

test('unknown environment default retains the existing absent-file readiness policy', () => {
    process.env['CLI_JAW_DEFAULT_CLI'] = 'unknown-runtime';
    unlinkSync(config.SETTINGS_PATH);
    const loaded = config.loadSettings();
    assert.equal(loaded.cli, 'pi');
    assert.equal(loaded.runtimeSelectionDiagnostic, null);
    assert.equal(pickerCalls, 1);
    assert.equal(processCalls, 0);
    process.env['CLI_JAW_DEFAULT_CLI'] = 'jwc';
});

test('corrupt document retains the existing clobber guard despite retired environment default', () => {
    writeFileSync(config.SETTINGS_PATH, '{broken');
    const beforePicker = pickerCalls;
    const loaded = config.loadSettings();
    assert.equal(loaded.cli, 'claude');
    assert.equal(loaded.runtimeSelectionDiagnostic, null);
    assert.equal(config.isSettingsPersistenceBlocked(), true);
    assert.equal(readFileSync(config.SETTINGS_PATH, 'utf8'), '{broken');
    assert.equal(pickerCalls, beforePicker);
    assert.equal(processCalls, 0);
});
