import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readIsolatedQaPolicy, isolatedQaEnvironment, assertIsolatedQaScan, type IsolatedQaRole } from '../../src/shared/isolated-qa.ts';

// Independent literal layout oracle, deliberately not imported from the parser.
const layout = { HOME: 'home', TMPDIR: 'tmp', XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache',
    XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state', CLI_JAW_DASHBOARD_HOME: 'dashboard',
    CODEX_HOME: 'providers/codex', CLAUDE_CONFIG_DIR: 'providers/claude', PI_CODING_AGENT_DIR: 'providers/pi' };
function fixture(t: TestContext, role: IsolatedQaRole = 'manager') {
    const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'jaw-qa-policy-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const suffix of [...Object.values(layout), 'worker', 'manager', 'electron/userData', 'electron/sessionData', 'electron/logs', 'electron/crashDumps'])
        mkdirSync(path.join(root, suffix), { recursive: true });
    const env: NodeJS.ProcessEnv = { CLI_JAW_ISOLATED_QA_ROOT: root, CLI_JAW_HOME: path.join(root, role === 'worker' ? 'worker' : 'manager'),
        DASHBOARD_SCAN_FROM: '45110', DASHBOARD_SCAN_COUNT: '1', DASHBOARD_PORT: '45111', DASHBOARD_PREVIEW_FROM: '45112',
        PATH: path.dirname(process.execPath), PORT: '45110' };
    for (const [key, suffix] of Object.entries(layout)) env[key] = path.join(root, suffix);
    return { root, env };
}
function invalid(fn: () => unknown, field?: string) {
    assert.throws(fn, (error: unknown) => {
        const value = error as Error & { code?: string; statusCode?: number };
        assert.equal(value.code, 'isolated_qa_invalid'); assert.equal(value.statusCode, 400);
        if (field) assert.ok(value.message.includes(field));
        return true;
    });
}

test('policy import is inert and absence preserves normal mode without filesystem probes', async t => {
    let reads = 0;
    t.mock.module('node:fs', { namedExports: {
        realpathSync: Object.assign(() => { reads++; throw Error('unexpected fs'); }, { native() { reads++; throw Error('unexpected fs'); } }),
        statSync() { reads++; throw Error('unexpected fs'); },
    } });
    const module = await import(new URL('../../src/shared/isolated-qa.ts?inert-import', import.meta.url).href);
    assert.equal(module.readIsolatedQaPolicy({ HOME: 'not-a-qa-home' }, 'manager'), null);
    assert.equal(reads, 0);
});

for (const role of ['worker', 'manager', 'electron'] as const) {
    test(`valid ${role} gets exact immutable role and port identity`, t => {
        const { root, env } = fixture(t, role);
        const policy = readIsolatedQaPolicy(env, role)!;
        assert.equal(policy.root, root); assert.equal(policy.role, role);
        assert.equal(policy.jawHome, path.join(root, role === 'worker' ? 'worker' : 'manager'));
        assert.equal(policy.home, path.join(root, 'home')); assert.equal(policy.temporary, path.join(root, 'tmp'));
        assert.equal(policy.dashboardHome, path.join(root, 'dashboard'));
        assert.deepEqual([policy.workerPort, policy.managerPort, policy.previewPort, policy.managerUrl], [45110, 45111, 45112, 'http://127.0.0.1:45111/']);
        assert.deepEqual(policy.electron, { userData: path.join(root, 'electron/userData'), sessionData: path.join(root, 'electron/sessionData'),
            logs: path.join(root, 'electron/logs'), crashDumps: path.join(root, 'electron/crashDumps') });
        assert.equal(Object.isFrozen(policy), true); assert.equal(Object.isFrozen(policy.electron), true);
        const clean = isolatedQaEnvironment(policy, env);
        assert.equal(clean['PORT'], role === 'worker' ? '45110' : undefined);
        assert.equal(clean['USERPROFILE'], path.join(root, 'home'));
        assert.equal(clean['APPDATA'], path.join(root, 'xdg/data'));
        assert.equal(clean['LOCALAPPDATA'], path.join(root, 'xdg/cache'));
        assert.equal(clean['TEMP'], path.join(root, 'tmp'));
        assert.equal(clean['TMP'], path.join(root, 'tmp'));
        assert.deepEqual(readIsolatedQaPolicy(clean, role), policy, 'constructed environment must be admitted again');
    });
}

for (const root of [undefined, '', ' ', '.', '../home', '/missing-qa-root', '/bad\nroot']) {
    test(`present malformed root rejects (${JSON.stringify(root)})`, () => {
        invalid(() => readIsolatedQaPolicy({ CLI_JAW_ISOLATED_QA_ROOT: root }, 'manager'), 'CLI_JAW_ISOLATED_QA_ROOT');
    });
}
test('filesystem root and noncanonical path aliases reject', t => {
    const { env, root } = fixture(t);
    invalid(() => readIsolatedQaPolicy({ ...env, CLI_JAW_ISOLATED_QA_ROOT: path.parse(root).root }, 'manager'));
    invalid(() => readIsolatedQaPolicy({ ...env, CLI_JAW_ISOLATED_QA_ROOT: root + path.sep }, 'manager'));
});
for (const key of Object.keys(layout)) {
    test(`missing or sibling-prefix ${key} cannot escape the fixed layout`, t => {
        const { root, env } = fixture(t);
        invalid(() => readIsolatedQaPolicy({ ...env, [key]: undefined }, 'manager'), key);
        invalid(() => readIsolatedQaPolicy({ ...env, [key]: root + '-sibling' }, 'manager'), key);
    });
}
test('worker/manager homes must not collide', t => {
    const { env } = fixture(t);
    invalid(() => readIsolatedQaPolicy(env, 'worker'), 'CLI_JAW_HOME');
});
test('missing, file or escaped-symlink layout paths reject without changing outside state', t => {
    const { root, env } = fixture(t);
    const target = path.join(root, 'electron/logs');
    rmSync(target, { recursive: true }); invalid(() => readIsolatedQaPolicy(env, 'manager'));
    writeFileSync(target, 'not a directory'); invalid(() => readIsolatedQaPolicy(env, 'manager')); rmSync(target);
    const outside = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'jaw-qa-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const sentinel = path.join(outside, 'sentinel'); writeFileSync(sentinel, 'unchanged');
    symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    invalid(() => readIsolatedQaPolicy(env, 'manager'));
    assert.equal(realpathSync.native(target), outside);
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
});
for (const value of [undefined, '', '0', '-1', '1.5', '01', ' 45111', '+45111', '65536', 'NaN', 'Infinity']) {
    test(`invalid explicit port rejects (${JSON.stringify(value)})`, t => {
        const { env } = fixture(t);
        invalid(() => readIsolatedQaPolicy({ ...env, DASHBOARD_PORT: value }, 'manager'), 'DASHBOARD_PORT');
    });
}
test('all three ports are required and pairwise distinct; count is literal one', t => {
    const { env } = fixture(t);
    for (const key of ['DASHBOARD_SCAN_FROM', 'DASHBOARD_PREVIEW_FROM']) invalid(() => readIsolatedQaPolicy({ ...env, [key]: undefined }, 'manager'), key);
    for (const [key, value] of [['DASHBOARD_SCAN_FROM', '45111'], ['DASHBOARD_PREVIEW_FROM', '45111'], ['DASHBOARD_PREVIEW_FROM', '45110']])
        invalid(() => readIsolatedQaPolicy({ ...env, [key!]: value }, 'manager'), 'ports');
    for (const value of [undefined, '0', '2', '1.0', ' 1']) invalid(() => readIsolatedQaPolicy({ ...env, DASHBOARD_SCAN_COUNT: value }, 'manager'), 'DASHBOARD_SCAN_COUNT');
});
test('worker PORT is explicit and cannot target manager', t => {
    const { env } = fixture(t, 'worker');
    for (const value of [undefined, '0', '45111']) invalid(() => readIsolatedQaPolicy({ ...env, PORT: value }, 'worker'), 'PORT');
});
test('optional Windows profile roots must agree when supplied', t => {
    const { root, env } = fixture(t);
    const values = { USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'xdg/data'), LOCALAPPDATA: path.join(root, 'xdg/cache'),
        TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp') };
    assert.ok(readIsolatedQaPolicy({ ...env, ...values }, 'manager'));
    for (const key of Object.keys(values)) invalid(() => readIsolatedQaPolicy({ ...env, [key]: path.join(root, 'worker') }, 'manager'), key);
});
test('fresh child environment excludes inherited secrets, overrides and execution flags', t => {
    const { env } = fixture(t);
    const policy = readIsolatedQaPolicy(env, 'manager')!;
    const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'NODE_OPTIONS',
        'JAW_BIN', 'CLI_JAW_BIN', 'ELECTRON_RUN_AS_NODE', 'BASH_ENV', 'ENV', 'npm_config_userconfig', 'AWS_PROFILE'];
    const source: NodeJS.ProcessEnv = { ...env, LANG: 'ko_KR.UTF-8', NODE_OPTIONS: 'fixture-not-executed' };
    for (const key of names) source[key] = 'fixture-secret-value';
    const before = JSON.stringify(source);
    const child = isolatedQaEnvironment(policy, source);
    for (const key of names) assert.equal(Object.hasOwn(child, key), false, key);
    assert.notEqual(child, source); assert.equal(JSON.stringify(source), before);
    assert.equal(child['LANG'], 'ko_KR.UTF-8'); assert.equal(child['CLI_JAW_SKIP_AUTOMATION_PRIME'], '1');
    assert.equal(child['JAW_OPEN_BROWSER'], '0'); assert.equal(child['JAW_DASHBOARD_OPEN'], '0');
});
test('child PATH rejects implicit working directory or control input', t => {
    const { env } = fixture(t); const policy = readIsolatedQaPolicy(env, 'manager')!;
    for (const value of ['', '.', path.dirname(process.execPath) + path.delimiter, '/bad\npath'])
        invalid(() => isolatedQaEnvironment(policy, { ...env, PATH: value }), 'PATH');
});
test('only the existing 32-byte task renderer token crosses its named exception', t => {
    const { env } = fixture(t); const policy = readIsolatedQaPolicy(env, 'manager')!;
    const token = 'ab'.repeat(32);
    assert.equal(isolatedQaEnvironment(policy, { ...env, CLI_JAW_ELECTRON_RENDERER_TOKEN: token })['CLI_JAW_ELECTRON_RENDERER_TOKEN'], token);
    assert.equal(isolatedQaEnvironment(policy, env)['CLI_JAW_ELECTRON_RENDERER_TOKEN'], undefined);
    const secret = 'fixture-provider-secret';
    assert.throws(() => isolatedQaEnvironment(policy, { ...env, CLI_JAW_ELECTRON_RENDERER_TOKEN: secret }), error => {
        assert.ok(!(error as Error).message.includes(secret)); return true;
    });
});
test('QA scan gate rejects any foreign range; normal mode keeps its own validator', t => {
    const { env } = fixture(t); const policy = readIsolatedQaPolicy(env, 'manager')!;
    assert.doesNotThrow(() => assertIsolatedQaScan(policy, 45110, 1));
    for (const [from, count] of [[45109, 1], [45111, 1], [45110, 2], [45110, 0], [NaN, 1]])
        assert.throws(() => assertIsolatedQaScan(policy, from!, count!), error => {
            assert.equal((error as { statusCode: number }).statusCode, 403); return true;
        });
    assert.doesNotThrow(() => assertIsolatedQaScan(null, NaN, -1));
});
