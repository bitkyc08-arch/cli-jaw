import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    applyCliEnvDefaults,
    buildSessionResumeKey,
    ensureOpencodeAlwaysAllowPermissions,
    getOpencodePreferredBinDir,
    withOpencodeAlwaysAllowPermissions,
} from '../../src/agent/spawn-env.ts';

function withoutPath(env: Record<string, string>): Record<string, string> {
    const { PATH: _path, ...rest } = env;
    return rest;
}

test('enables Exa by default for opencode when unset', () => {
    assert.deepEqual(
        withoutPath(applyCliEnvDefaults('opencode', {}, {})),
        { OPENCODE_ENABLE_EXA: 'true' },
    );
});

test('preserves explicit opencode override', () => {
    assert.deepEqual(
        withoutPath(applyCliEnvDefaults('opencode', { OPENCODE_ENABLE_EXA: 'false' }, {})),
        { OPENCODE_ENABLE_EXA: 'false' },
    );
});

test('preserves inherited opencode env when already set', () => {
    assert.deepEqual(
        withoutPath(applyCliEnvDefaults('opencode', { OTHER_FLAG: '1' }, { OPENCODE_ENABLE_EXA: '1' })),
        { OTHER_FLAG: '1' },
    );
});

test('trusts Gemini workspaces by default for headless boss and employee spawns', () => {
    assert.deepEqual(
        applyCliEnvDefaults('gemini', {}, {}),
        { GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    );
});

test('preserves explicit Gemini trust override', () => {
    assert.deepEqual(
        applyCliEnvDefaults('gemini', { GEMINI_CLI_TRUST_WORKSPACE: 'false' }, {}),
        { GEMINI_CLI_TRUST_WORKSPACE: 'false' },
    );
});

test('preserves inherited Gemini trust env when already set', () => {
    assert.deepEqual(
        applyCliEnvDefaults('gemini', { OTHER_FLAG: '1' }, { GEMINI_CLI_TRUST_WORKSPACE: '1' }),
        { OTHER_FLAG: '1' },
    );
});

test('prefers bun-installed opencode before older path entries', () => {
    const next = applyCliEnvDefaults('opencode', {}, { PATH: '/opt/homebrew/bin:/usr/bin' });
    assert.ok(next.PATH?.startsWith(`${getOpencodePreferredBinDir()}:`));
});

test('moves bun-installed opencode to the front when it already exists later in PATH', () => {
    const bun = getOpencodePreferredBinDir();
    const next = applyCliEnvDefaults('opencode', {}, { PATH: `/opt/homebrew/bin:${bun}:/usr/bin` });
    const parts = next.PATH?.split(':') || [];
    assert.equal(parts[0], bun);
    assert.equal(parts.filter(part => part === bun).length, 1);
});

test('does not modify non-opencode env', () => {
    assert.deepEqual(
        applyCliEnvDefaults('claude', { OTHER_FLAG: '1' }, {}),
        { OTHER_FLAG: '1' },
    );
});

test('builds opencode resume key from effective Exa env', () => {
    assert.equal(buildSessionResumeKey('opencode', { OPENCODE_ENABLE_EXA: 'true' }), 'exa=1');
    assert.equal(buildSessionResumeKey('opencode', { OPENCODE_ENABLE_EXA: '1' }), 'exa=1');
    assert.equal(buildSessionResumeKey('opencode', { OPENCODE_ENABLE_EXA: 'false' }), 'exa=0');
    assert.equal(buildSessionResumeKey('claude', {}), null);
});

test('opencode permission config always allows dynamic jaw homes', () => {
    const next = withOpencodeAlwaysAllowPermissions({
        permission: { websearch: 'ask' },
        provider: { lidge: true },
    });

    assert.equal(next.$schema, 'https://opencode.ai/config.json');
    assert.deepEqual(next.provider, { lidge: true });
    assert.equal((next.permission as Record<string, unknown>)['*'], 'allow');
    assert.equal((next.permission as Record<string, unknown>).external_directory, 'allow');
    assert.equal((next.permission as Record<string, unknown>).websearch, 'allow');
    assert.equal((next.permission as Record<string, unknown>).bash, 'allow');
});

test('writes opencode always-allow permissions without dropping existing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-opencode-'));
    const configPath = join(dir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify({
        permission: { webfetch: 'allow' },
        provider: { lidge: { models: { test: true } } },
    }, null, 2));

    ensureOpencodeAlwaysAllowPermissions(configPath);

    const next = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(next.permission.external_directory, 'allow');
    assert.equal(next.permission.webfetch, 'allow');
    assert.equal(next.permission.question, 'allow');
    assert.deepEqual(next.provider, { lidge: { models: { test: true } } });
});
