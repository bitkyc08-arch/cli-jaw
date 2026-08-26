/**
 * #479 regression: on a host with no service manager (PID 1 = tini, no
 * systemd), `jaw service` told the operator to run `jaw serve` under
 * tmux/screen. That advice cannot be followed from the one-shot
 * `ssh host '...'` command that lands people there, and a multiplexer would
 * inherit the same non-interactive PATH that already failed to resolve `jaw`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { manualStartCommand, manualSupervisionGuidance } from '../../src/manager/manual-supervision.ts';

// The reporter's host, verbatim from the issue.
const CTX = {
    nodePath: '/home/box/.local/lib/nodejs/node-v24.19.0-linux-x64/bin/node',
    jawPath: '/home/box/.local/bin/jaw',
    home: '/home/box/.cli-jaw',
    port: '3457',
    logPath: '/home/box/.cli-jaw/logs/jaw-serve.log',
};

test('MS-001: the start command uses absolute paths, never a bare jaw', () => {
    const cmd = manualStartCommand(CTX);
    assert.ok(cmd.includes(CTX.nodePath), 'node must be absolute');
    assert.ok(cmd.includes(CTX.jawPath), 'jaw must be absolute');
    // A bare `jaw` is the exact token that fails on these hosts.
    assert.doesNotMatch(cmd, /(^|\s)jaw\s/, 'a PATH-resolved jaw would reproduce the bug');
});

test('MS-002: the command survives the ssh session that launched it', () => {
    const cmd = manualStartCommand(CTX);
    assert.match(cmd, /setsid/, 'must detach from the session leader');
    assert.match(cmd, /< \/dev\/null/, 'must not block on a disappearing terminal');
    assert.match(cmd, /&$/, 'must background');
    assert.match(cmd, />> /, 'must keep a log to diagnose a silent death');
});

test('MS-003: guidance never suggests an interactive multiplexer', () => {
    const text = manualSupervisionGuidance(CTX).join('\n');
    assert.doesNotMatch(text, /tmux|screen/, 'unusable from a one-shot ssh command');
});

test('MS-004: guidance tells the operator how to confirm it actually started', () => {
    // The #479 failure mode is silence: the process dies and a pid file or a
    // clean exit code implies health. Guidance must point at a real check.
    const text = manualSupervisionGuidance(CTX).join('\n');
    assert.match(text, /service status/, 'must offer a liveness check');
    assert.match(text, /tail -n 50/, 'must point at the log on failure');
    assert.match(text, /supervisor loop/, 'systemd-less hosts need a restart story');
});

test('MS-005: paths containing spaces are quoted', () => {
    const cmd = manualStartCommand({ ...CTX, home: '/home/box/my jaw home' });
    assert.match(cmd, /'\/home\/box\/my jaw home'/);
});

test('MS-006: service.ts no longer prints the tmux advice', () => {
    const src = readFileSync(new URL('../../bin/commands/service.ts', import.meta.url), 'utf8');
    // Comments may still explain WHY the advice was removed; what must not
    // survive is a console line that prints it.
    const printed = src.split(/\r?\n/).filter(line => /console\.(log|error|warn)/.test(line)).join('\n');
    assert.doesNotMatch(printed, /tmux|screen/, '#479: tmux/screen advice was unusable from a one-shot ssh command');
    assert.match(src, /manualSupervisionGuidance/, 'the no-backend path must print real guidance');
});

test('MS-007: the docker branch warns when jaw is not the entrypoint', () => {
    // Exiting 0 with "restart policy handles it" implied a daemon existed
    // when `jaw service` had started nothing.
    const src = readFileSync(new URL('../../bin/commands/service.ts', import.meta.url), 'utf8');
    const dockerBranch = src.slice(src.indexOf("if (backend === 'docker')"), src.indexOf("if (backend === 'windows')"));
    assert.match(dockerBranch, /nothing is supervising it/);
    assert.match(dockerBranch, /manualSupervisionGuidance/);
});
