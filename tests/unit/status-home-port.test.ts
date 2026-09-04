import '../setup/isolated-home.ts';
// #436: `jaw --home <path> status` probed 3457 regardless of which instance the
// home belonged to. --home only set CLI_JAW_HOME; the port flag carried a default
// of process.env.PORT || 3457, which made "omitted" indistinguishable from
// "explicitly 3457". These run the real command in a child so the resolution
// order is proven end to end, not by reading the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');

function statusJson(home: string, extraArgs: string[] = []): { port?: string } {
    // The server is not running in any of these homes, so status exits 1 and
    // prints the not-running line. The port it NAMES is what is under test.
    try {
        const out = execFileSync(
            process.execPath,
            // '--import tsx', not node_modules/.bin/tsx: that path is a POSIX shell
            // wrapper under some installer layouts, and node parses it as CommonJS
            // and dies on line 2 before any test code runs, leaving stdout empty and
            // every assertion below matching against '' (#521). The 13 other
            // subprocess tests in this suite already spawn tsx this way.
            ['--import', 'tsx', join(projectRoot, 'bin/cli-jaw.ts'), 'status', ...extraArgs],
            { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, CLI_JAW_HOME: home, PORT: '' }, timeout: 60000 },
        );
        return { port: out };
    } catch (e) {
        const err = e as { stdout?: string };
        return { port: err.stdout ?? '' };
    }
}

test('STP-001: with no --port, status reads the home pidfile', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-status-pid-'));
    writeFileSync(join(home, 'jaw.pid.json'), JSON.stringify({ pid: 1, port: 3462, home, version: 'x' }));
    const out = statusJson(home).port ?? '';
    assert.match(out, /3462/, 'the port must come from this home, not the 3457 default');
    assert.doesNotMatch(out, /port 3457/, 'the built-in default must not win over the home pidfile');
});

test('STP-002: settings.port is the fallback when no pidfile exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-status-set-'));
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ port: 3471 }));
    const out = statusJson(home).port ?? '';
    assert.match(out, /3471/, 'a configured-but-stopped instance still reports its own port');
});

test('STP-003: an explicit --port still wins over both', () => {
    const home = mkdtempSync(join(tmpdir(), 'jaw-status-exp-'));
    writeFileSync(join(home, 'jaw.pid.json'), JSON.stringify({ pid: 1, port: 3462, home, version: 'x' }));
    const out = statusJson(home, ['--port', '3480']).port ?? '';
    assert.match(out, /3480/, 'an explicit flag is the operator speaking; it outranks discovery');
});
