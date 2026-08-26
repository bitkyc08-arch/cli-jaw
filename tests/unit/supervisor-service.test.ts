/**
 * #479: hosts with no service manager (PID 1 = tini, no systemd) had no way
 * to keep `jaw serve` alive, so operators hand-rolled a supervisor loop. This
 * covers the generated loop's decision logic and the portability traps that
 * only surfaced by actually running it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSupervisorScript, supervisorInstallSummary } from '../../src/manager/supervisor-service.ts';

const CTX = {
    nodePath: '/home/box/.local/lib/nodejs/node-v24.19.0-linux-x64/bin/node',
    jawPath: '/home/box/.local/bin/jaw',
    home: '/home/box/.cli-jaw',
    port: '3457',
    logPath: '/home/box/.cli-jaw/logs/jaw-serve.log',
    intervalSeconds: 60,
};

test('SUP-001: the generated script is valid POSIX sh', () => {
    // Not bash: minimal containers ship dash as /bin/sh and may lack bash.
    const dir = mkdtempSync(join(tmpdir(), 'jaw-sup-'));
    const path = join(dir, 'supervisor.sh');
    writeFileSync(path, renderSupervisorScript(CTX));
    execFileSync('sh', ['-n', path]);   // throws on a syntax error
});

test('SUP-002: setsid is optional, because macOS and minimal images lack it', () => {
    // Observed by running the loop: an unguarded `setsid` made every start
    // fail with "command not found", so the supervisor started nothing at all.
    const script = renderSupervisorScript(CTX);
    assert.match(script, /command -v setsid/, 'must probe before use');
    assert.match(script, /if \[ -n "\$SETSID" \]/, 'must branch on availability');
    assert.match(script, /else\n\s+nohup /, 'must still nohup when setsid is missing');
});

test('SUP-003: liveness is asked of jaw, not of a process name', () => {
    // `service status` verifies the pidfile against the OS process start time,
    // so a recycled PID reads as dead. A pgrep-style check would keep a dead
    // server "running" forever — the #479 misdiagnosis.
    const script = renderSupervisorScript(CTX);
    assert.match(script, /service status/);
    assert.doesNotMatch(script, /pgrep|pidof/, 'process-name matching cannot detect PID recycling');
});

test('SUP-004: every command uses an absolute path', () => {
    const script = renderSupervisorScript(CTX);
    assert.match(script, /NODE='\/home\/box/);
    assert.match(script, /JAW='\/home\/box\/\.local\/bin\/jaw'/);
    // A bare `jaw` is exactly what does not resolve on these hosts.
    assert.doesNotMatch(script, /^\s*jaw /m);
});

test('SUP-005: the loop terminates on TERM instead of orphaning', () => {
    // An orphan loop would fight the next start.
    const script = renderSupervisorScript(CTX);
    assert.match(script, /trap .* TERM INT/);
    assert.match(script, /exit 0/);
});

test('SUP-006: the loop redirects stdin so it cannot block on a dead terminal', () => {
    assert.match(renderSupervisorScript(CTX), /< \/dev\/null/);
});

test('SUP-007: shell metacharacters in paths are quoted', () => {
    const script = renderSupervisorScript({ ...CTX, home: "/home/box/it's here" });
    const dir = mkdtempSync(join(tmpdir(), 'jaw-sup-'));
    const path = join(dir, 'supervisor.sh');
    writeFileSync(path, script);
    execFileSync('sh', ['-n', path]);
});

test('SUP-008: a sub-second interval cannot produce a busy loop', () => {
    assert.match(renderSupervisorScript({ ...CTX, intervalSeconds: 0 }), /INTERVAL=1/);
    assert.match(renderSupervisorScript({ ...CTX, intervalSeconds: 0.4 }), /INTERVAL=1/);
});

test('SUP-009: the summary tells the operator where to wire the loop in', () => {
    // Writing the script is not registering autostart; saying otherwise would
    // repeat the #479 failure of implying a daemon exists.
    const text = supervisorInstallSummary('/home/box/.cli-jaw/jaw-supervisor.sh', CTX).join('\n');
    assert.match(text, /no service manager/);
    assert.match(text, /entrypoint/);
    assert.match(text, /@reboot/);
});

test('SUP-010: service.ts exposes supervisor as an opt-in backend', () => {
    const src = readFileSync(new URL('../../bin/commands/service.ts', import.meta.url), 'utf8');
    assert.match(src, /'supervisor'/, 'must be a selectable backend');
    assert.match(src, /VALID_BACKENDS = new Set\(\[[^\]]*'supervisor'/, 'must pass flag validation');
    // detectBackend must not choose it silently: writing a script is not the
    // same act as registering autostart.
    const detect = src.slice(src.indexOf('function detectBackend'), src.indexOf('const backend: Backend'));
    assert.doesNotMatch(detect, /return 'supervisor'/, 'supervisor stays opt-in');
});

test('SUP-011: supervisor status exits non-zero when the server is down', () => {
    // The generated loop branches on this exit code. systemd's status branch
    // exits 0 either way; a supervisor trusting that never restarts anything.
    const src = readFileSync(new URL('../../bin/commands/service.ts', import.meta.url), 'utf8');
    const branch = src.slice(src.indexOf("if (backend === 'supervisor')"), src.indexOf("if (backend === 'windows')"));
    assert.match(branch, /verifyOwnership\(JAW_HOME, defaultLifecycleDeps\)/, 'must verify real ownership');
    assert.match(branch, /process\.exit\(running \? 0 : 1\)/, 'liveness must reach the exit code');
});

