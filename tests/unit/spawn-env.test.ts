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
import { makeCleanEnv } from '../../src/agent/spawn.ts';

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

test('darwin cursor children default AGENT_CLI_CREDENTIAL_STORE to file', () => {
    // launchd injects this on the parent; the gap is jaw serve / SSH (#393).
    assert.deepEqual(
        applyCliEnvDefaults('cursor', {}, {}, 'darwin'),
        { AGENT_CLI_CREDENTIAL_STORE: 'file' },
    );
    // A user choice — explicit or inherited — is never overwritten.
    assert.deepEqual(
        applyCliEnvDefaults('cursor', { AGENT_CLI_CREDENTIAL_STORE: 'keychain' }, {}, 'darwin'),
        { AGENT_CLI_CREDENTIAL_STORE: 'keychain' },
    );
    assert.deepEqual(
        applyCliEnvDefaults('cursor', {}, { AGENT_CLI_CREDENTIAL_STORE: 'keychain' }, 'darwin'),
        { AGENT_CLI_CREDENTIAL_STORE: 'keychain' },
    );
    // Non-darwin platforms are untouched.
    assert.deepEqual(applyCliEnvDefaults('cursor', {}, {}, 'linux'), {});
});

test('preserves inherited opencode env when already set', () => {
    assert.deepEqual(
        withoutPath(applyCliEnvDefaults('opencode', { OTHER_FLAG: '1' }, { OPENCODE_ENABLE_EXA: '1' })),
        { OTHER_FLAG: '1' },
    );
});


test('prefers bun-installed opencode before older path entries', () => {
    // Pin the platform: these fixtures are POSIX-shaped and assert a ':' separator,
    // so inheriting the host platform made them fail on a real Windows runner where
    // the joined PATH correctly uses ';'.
    const next = applyCliEnvDefaults('opencode', {}, { PATH: '/opt/homebrew/bin:/usr/bin' }, 'linux');
    assert.ok(next.PATH?.startsWith(`${getOpencodePreferredBinDir()}:`));
});

test('moves bun-installed opencode to the front when it already exists later in PATH', () => {
    // Host-independent on purpose. getOpencodePreferredBinDir() returns a REAL path,
    // and on Windows that is 'C:\\Users\\...', which a POSIX split reads as two
    // entries — so the duplicate was never recognized and the count came back 2 on
    // the native runner while passing on macOS. Use the win32 separator so the
    // fixture parses the same way everywhere.
    const bun = getOpencodePreferredBinDir();
    const next = applyCliEnvDefaults('opencode', {}, { PATH: '/opt/homebrew/bin;' + bun + ';/usr/bin' }, 'win32');
    const parts = (next.PATH ?? '').split(';');
    assert.equal(parts[0], bun, 'the preferred bin must be prepended');
    assert.equal(parts.filter(part => part === bun).length, 1, 'and must appear exactly once');
    assert.ok(parts.includes('/opt/homebrew/bin') && parts.includes('/usr/bin'), 'other entries survive');
});

test('preserves native Windows PATH entries when prepending the opencode bin', () => {
    const next = applyCliEnvDefaults(
        'opencode',
        {},
        { Path: String.raw`C:\Windows\System32;C:\Program Files\nodejs` },
        'win32',
    );
    assert.deepEqual(next.PATH?.split(';').slice(1), [
        String.raw`C:\Windows\System32`,
        String.raw`C:\Program Files\nodejs`,
    ]);
});

test('normalizes a mixed Git Bash PATH into a native Windows PATH', () => {
    const next = applyCliEnvDefaults(
        'opencode',
        {},
        { PATH: String.raw`/mingw64/bin:/usr/bin:C:\Users\jun\AppData\Roaming\npm` },
        'win32',
    );
    assert.deepEqual(next.PATH?.split(';').slice(1), [
        '/mingw64/bin',
        '/usr/bin',
        String.raw`C:\Users\jun\AppData\Roaming\npm`,
    ]);
});

test('deduplicates Windows PATH entries case-insensitively and emits one PATH key', () => {
    const bun = getOpencodePreferredBinDir();
    const next = applyCliEnvDefaults(
        'opencode',
        { Path: `C:\\Tools;${bun.toUpperCase()}` },
        {},
        'win32',
    );
    const parts = next.PATH?.split(';') || [];
    assert.equal(parts[0], bun);
    assert.equal(parts.filter(part => part.toLowerCase() === bun.toLowerCase()).length, 1);
    assert.equal(Object.keys(next).filter(key => key.toLowerCase() === 'path').length, 1);
});

test('does not modify non-opencode env', () => {
    assert.deepEqual(
        applyCliEnvDefaults('claude', { OTHER_FLAG: '1' }, {}),
        { OTHER_FLAG: '1' },
    );
});

test('sets NO_COLOR for agy plain text output by default', () => {
    assert.deepEqual(
        applyCliEnvDefaults('agy', {}, {}),
        { NO_COLOR: '1' },
    );
});

test('preserves explicit agy NO_COLOR override', () => {
    assert.deepEqual(
        applyCliEnvDefaults('agy', { NO_COLOR: '0' }, {}),
        { NO_COLOR: '0' },
    );
});

test('sets NO_COLOR for kiro-code plain text output by default', () => {
    assert.deepEqual(
        applyCliEnvDefaults('kiro-code', {}, {}),
        { NO_COLOR: '1' },
    );
});

test('sets NO_COLOR for grok streaming-json output by default', () => {
    assert.deepEqual(
        applyCliEnvDefaults('grok', {}, {}),
        { NO_COLOR: '1' },
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

test('SE-010: Windows dedupes arbitrary entries case-insensitively', () => {
    const result = applyCliEnvDefaults(
        'opencode',
        {},
        { PATH: String.raw`C:\Tools;c:\tools\;C:\Windows\System32;C:\TOOLS` },
        'win32',
    );
    const parts = result["PATH"]!.split(';');
    const lowered = parts.map(p => p.toLowerCase().replace(/\\+$/, ''));
    assert.equal(new Set(lowered).size, lowered.length, `duplicate entries survived: ${result["PATH"]}`);
    // First spelling wins, and the real system directory is never dropped.
    assert.ok(parts.includes(String.raw`C:\Tools`));
    assert.ok(!parts.includes(String.raw`C:\TOOLS`));
    assert.ok(parts.includes(String.raw`C:\Windows\System32`));
});

test('SE-011: POSIX keeps duplicate entries and is case-sensitive', () => {
    const result = applyCliEnvDefaults(
        'opencode',
        {},
        { PATH: '/usr/bin:/USR/BIN:/usr/bin' },
        'linux',
    );
    const parts = result["PATH"]!.split(':');
    // /usr/bin and /USR/BIN are different directories on a case-sensitive filesystem,
    // so collapsing them would silently drop a real PATH entry.
    assert.ok(parts.includes('/usr/bin'));
    assert.ok(parts.includes('/USR/BIN'));
});

test('SE-012: only one PATH key survives regardless of inherited casing', () => {
    const result = applyCliEnvDefaults(
        'opencode',
        { Path: String.raw`C:\FromExtra` },
        { PATH: String.raw`C:\FromInherited` },
        'win32',
    );
    const pathKeys = Object.keys(result).filter(k => k.toLowerCase() === 'path');
    assert.deepEqual(pathKeys, ['PATH']);
    assert.ok(result["PATH"]!.includes(String.raw`C:\FromExtra`));
});

test('MCE-001: win32 collapses Path and PATH into one canonical key', () => {
    const result = makeCleanEnv(
        {},
        { Path: String.raw`C:\Windows\System32`, USERPROFILE: String.raw`C:\Users\jun` },
        'win32',
    );
    const pathKeys = Object.keys(result).filter(k => k.toLowerCase() === 'path');
    assert.deepEqual(pathKeys, ['PATH'], `expected one canonical key, got ${pathKeys.join(',')}`);
    assert.ok(result["PATH"]!.toLowerCase().includes('system32'));
});

test('MCE-002: win32 extraEnv PATH override wins over the inherited value', () => {
    const result = makeCleanEnv(
        { Path: String.raw`C:\FromExtra` },
        { PATH: String.raw`C:\FromInherited` },
        'win32',
    );
    const pathKeys = Object.keys(result).filter(k => k.toLowerCase() === 'path');
    assert.deepEqual(pathKeys, ['PATH']);
    // An explicit caller override must not be discarded just because it arrived
    // spelled 'Path' rather than 'PATH'.
    assert.ok(result["PATH"]!.includes(String.raw`C:\FromExtra`));
});

test('MCE-003: POSIX keeps Path and PATH as distinct variables', () => {
    const result = makeCleanEnv(
        {},
        { PATH: '/usr/bin', Path: '/some/unrelated/value' },
        'linux',
    );
    // On a case-sensitive platform these are two different variables, and deleting
    // one would silently destroy caller data.
    assert.equal(result["Path"], '/some/unrelated/value');
    assert.ok(result["PATH"]!.includes('/usr/bin'));
});

test('MCE-003b: the platform argument decides, not the host running the test', () => {
    // makeCleanEnv takes `platform`, but buildServicePath used to read
    // process.platform instead. The two agreed on every dev machine, so the gap
    // was invisible until win32 PATH-entry normalization landed and a POSIX env
    // asserted on the Windows runner had its entries rewritten (#471).
    const posix = makeCleanEnv({}, { PATH: '/usr/bin:/opt/tools' }, 'linux');
    assert.ok(posix["PATH"]!.includes('/usr/bin'));
    assert.ok(posix["PATH"]!.includes('/opt/tools'));

    // and the win32 branch still normalizes, whatever host asks for it.
    const win = makeCleanEnv({}, { PATH: String.raw`C:\Tools` }, 'win32');
    assert.ok(win["PATH"]!.includes(String.raw`C:\Tools`));
    assert.equal(win["PATH"]!.split(';').filter((entry) => entry.startsWith('/')).length, 0);
});
