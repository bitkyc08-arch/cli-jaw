/** Run explicitly with installed tsx; never included by broad test discovery.
 * tsx tests/smoke/tui-activity-pty.mts --built-head <HEAD> --build-report <json>
 *   --evidence <owned-directory>
 * Evidence is fixture/SSE/OS PTY, NOT real provider or durable backend persistence.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as poll } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { EventEmitter } from 'node:events';
import { createActivityFixture, LIMITS, OWNER, RUN_A, RUN_B } from '../fixtures/tui-activity-server.mts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
type Terminal = import('@xterm/xterm').Terminal;
type Frame = { type: string; data?: string; pid?: number; code?: number; error?: string | null;
    rows?: number; columns?: number; offset?: number; reaped?: boolean; fdsClosed?: boolean;
    groupLive?: boolean; ownershipUnknown?: boolean; authorityRevoked?: string;
    termiosRestored?: boolean; forced?: string[]; bytes?: number };
type Fixture = Awaited<ReturnType<typeof createActivityFixture>>;
type Verdict = { scenario: string; verdict: 'PASS' | 'FAIL' | 'NOT_RUN'; criterion: string; artifacts: string[]; detail?: string };
type FixtureChildHandle = { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null;
    kill(signal: NodeJS.Signals): boolean; once(event: 'exit' | 'error', listener: () => void): unknown };

/** Test-local child lifetime: never turn a post-exit numeric probe into a kill.
 * Node owns the handle/reaper. Bind exit (not just stdio close) synchronously.
 */
function fixtureChildFence(child: FixtureChildHandle, probe: (pid: number, signal: 0) => unknown = process.kill) {
    let revoked: string | null = null, unknown = false;
    const sent: NodeJS.Signals[] = [];
    const revoke = (reason: string) => { revoked ??= reason; };
    const owned = () => {
        if (child.exitCode !== null || child.signalCode !== null) revoke('known-exit/reaped');
        if (!child.pid) revoke('not-created');
        return revoked === null;
    };
    child.once('exit', () => revoke('known-exit/reaped'));
    child.once('error', () => revoke('child-error'));
    return {
        revoke,
        signal(signal: NodeJS.Signals) {
            if (!owned() || sent.includes(signal)) return false;
            // ChildProcess.kill uses its retained handle, not a numeric killpg.
            try {
                if (!child.kill(signal)) { revoke('ESRCH/no-live-handle'); return false; }
            } catch (error) {
                revoke('signal-error');
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                return false;
            }
            sent.push(signal); return true;
        },
        observeGroup() {
            owned();
            let groupLive: boolean | null = null;
            try {
                if (!child.pid) throw Error('no original PID');
                probe(-child.pid, 0); groupLive = true;
                if (revoked !== null) unknown = true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') { revoke('ESRCH'); groupLive = false; }
                else { revoke('probe-error'); unknown = true; }
            }
            return { groupLive, ownershipUnknown: unknown, authorityRevoked: revoked, signals: [...sent] };
        },
    };
}
type ChildFence = ReturnType<typeof fixtureChildFence>;
function requestFixtureDeadline(...fences: (ChildFence | undefined)[]) {
    for (const fence of fences) fence?.signal('SIGTERM');
}
async function waitExit(fence: ChildFence, exited: () => boolean, label: string,
    clock = { now: Date.now, pause: (ms: number) => poll(ms) }) {
    const end = clock.now() + 5000;
    if (!exited()) fence.signal('SIGTERM');
    while (!exited() && clock.now() < end) await clock.pause(20);
    if (!exited()) fence.signal('SIGKILL');
    const hard = clock.now() + 3000;
    while (!exited() && clock.now() < hard) await clock.pause(20);
    if (!exited()) throw Error(`${label}: unproven child-handle reap/close`);
    fence.revoke('known-exit/reaped');
}
function finishFixtureRoot(root: string | undefined, errors: string[], io = {
    remove: (dir: string) => fs.rmSync(dir, { recursive: true }), exists: fs.existsSync,
}) {
    let rootRemoved: boolean | null = null;
    try {
        if (root && errors.length === 0) io.remove(root);
        rootRemoved = root ? !io.exists(root) : null;
    } catch (error) { errors.push(errorOf(error)); rootRemoved = false; }
    return { root, rootRemoved, contained: errors.length === 0, errors };
}
function attemptPassed(failure: string | undefined, scenariosPassed: boolean, contained: boolean) {
    return !failure && scenariosPassed && contained;
}
function fixtureOwnershipError(ownership: { groupLive?: boolean | null; ownershipUnknown?: boolean }) {
    return ownership.groupLive !== false || ownership.ownershipUnknown !== false
        ? 'post-reap group ownership unknown (not signalled)' : undefined;
}
async function ownershipSelfTest() {
    const python = spawnSync('python3', ['-B', path.join(repo, 'tests/fixtures/tui-pty-bridge.py'), '--ownership-self-test'],
        { encoding: 'utf8', timeout: 2000, maxBuffer: LIMITS.frameBytes,
            // Same PATH selection as the real bridge, not the caller's Python.
            env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8' } });
    assert.equal(python.status, 0, python.stderr);
    const pythonResult = JSON.parse(python.stdout) as { passed: boolean; cases: { name: string; groupLive: boolean; ownershipUnknown: boolean }[] };
    assert.equal(pythonResult.passed, true);
    const cases: object[] = [];
    for (const name of ['already-reaped-reused-before-first-probe', 'ESRCH-then-reappearance',
        'owned-TERM-timeout-KILL', 'deadline-already-reaped', 'deadline-owned-timeout']) {
        const uncertain = !['owned-TERM-timeout-KILL', 'deadline-owned-timeout'].includes(name);
        const reaped = name.includes('already-reaped');
        const calls: [number, NodeJS.Signals][] = [], probes: [number, number][] = [];
        let missing = name === 'ESRCH-then-reappearance', ticks = 0;
        const emitter = new EventEmitter();
        const child = Object.assign(emitter, { pid: 424242, exitCode: reaped ? 0 : null as number | null,
            signalCode: null as NodeJS.Signals | null, kill(signal: NodeJS.Signals) {
                calls.push([this.pid, signal]);
                if (signal === 'SIGKILL') { this.exitCode = 0; emitter.emit('exit'); }
                return true;
            } });
        const fence = fixtureChildFence(child, (pid, signal) => {
            probes.push([pid, signal]);
            if (missing || !uncertain) { missing = false; throw Object.assign(Error('simulated ESRCH'), { code: 'ESRCH' }); }
        });
        if (name === 'ESRCH-then-reappearance') {
            assert.equal(fence.observeGroup().groupLive, false);
            assert.equal(fence.observeGroup().groupLive, true);
            // Still-null exit fields: this specifically exercises the ESRCH
            // latch, not a later known-exit guard masking a missing latch.
            requestFixtureDeadline(fence); fence.signal('SIGKILL');
            assert.deepEqual(calls, []);
            child.exitCode = 0; child.emit('exit');
        }
        if (name.startsWith('deadline')) requestFixtureDeadline(fence);
        await waitExit(fence, () => child.exitCode !== null, name, { now: () => ticks, pause: async ms => { ticks += ms; } });
        const ownership = fence.observeGroup();
        requestFixtureDeadline(fence); fence.signal('SIGKILL'); // cannot resurrect after reap/ESRCH
        assert.deepEqual(calls, uncertain ? [] : [[424242, 'SIGTERM'], [424242, 'SIGKILL']]);
        assert.ok(probes.every(([pid, sig]) => pid === -424242 && sig === 0));
        assert.equal(ownership.ownershipUnknown, uncertain);
        let present = true, removals = 0;
        const issue = fixtureOwnershipError(ownership);
        const outcome = finishFixtureRoot('/simulated-owned-root', issue ? [issue] : [], {
            remove: () => { present = false; removals++; }, exists: () => present,
        });
        assert.equal(outcome.contained, !uncertain); assert.equal(outcome.rootRemoved, !uncertain);
        assert.equal(attemptPassed(undefined, true, outcome.contained), !uncertain);
        assert.equal(removals, uncertain ? 0 : 1);
        cases.push({ name, calls, probes, ownership, ...outcome, passed: attemptPassed(undefined, true, outcome.contained), virtualMs: ticks });
    }
    // Python uncertainty travels through the SAME Node root/pass gate, not a
    // success-only bridge receipt interpretation. No real root is removed here.
    const pythonPropagation: object[] = [];
    for (const value of pythonResult.cases.filter(value => value.ownershipUnknown)) {
        let removed = false;
        const issue = fixtureOwnershipError(value);
        const outcome = finishFixtureRoot('/simulated-python-root', issue ? [issue] : [], {
            remove: () => { removed = true; }, exists: () => true,
        });
        assert.equal(removed, false); assert.equal(outcome.rootRemoved, false); assert.equal(outcome.contained, false);
        assert.equal(attemptPassed(undefined, true, outcome.contained), false);
        pythonPropagation.push({ name: value.name, ...outcome, passed: attemptPassed(undefined, true, outcome.contained), removals: 0 });
    }
    return { passed: true, simulatedOnly: true, python: pythonResult, node: cases, pythonPropagation };
}
if (process.argv[2] === '--ownership-self-test') {
    const extra = process.argv.slice(3);
    assert.ok(extra.length === 0 || (extra.length === 2 && extra[0] === '--evidence'), 'self-test optional --evidence DIR');
    let result: object;
    let code = 0;
    try { result = await ownershipSelfTest(); }
    catch (error) { result = { passed: false, simulatedOnly: true, error: errorOf(error) }; code = 1; }
    let output: string | undefined;
    if (extra[1]) {
        const parent = path.resolve(extra[1]); fs.mkdirSync(parent, { recursive: true });
        output = path.join(fs.mkdtempSync(path.join(parent, 'wp37-pty-ownership-')), 'result.json');
        fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    }
    console.log(JSON.stringify({ ...result, evidence: output })); process.exit(code);
}
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
    if (!['--built-head', '--build-report', '--evidence'].includes(args[i]!) || !args[i + 1] || options.has(args[i]!))
        throw Error('Expected --built-head SHA --build-report JSON --evidence OWNED_DIR');
    options.set(args[i]!, args[i + 1]!);
}
const evidenceRoot = path.resolve(options.get('--evidence') ?? '');
assert.ok(options.has('--evidence'), 'explicit evidence directory required');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'wp37-pty-attempt-'));
const started = Date.now();
const deadline = started + LIMITS.activeMs;
const criteria = [
    'compiled CLI submit, expand and Escape stop use owned fixture routes',
    'SSE reconnect catches up records and reads exact saved answer once',
    'F6 retained selection, read counts and draft survive OS resize 20 40 80 120',
    'bounded live stress cannot steal F6 selection or execute pasted controls',
    'idle exit restores terminal modes and reaps only owned children',
    'piped raw preserves unknown semantic NDJSON and performs no Activity reads',
];
const verdicts: Verdict[] = criteria.map((criterion, i) => ({ scenario: `P8.${i + 1}`, criterion, verdict: 'NOT_RUN', artifacts: [] }));
const checks: { name: string; capturedAt: string }[] = [];
const sizes = [{ offset: 0, columns: 80, rows: 24 }];
const ansi: Buffer[] = [], rawOut: Buffer[] = [], rawErr: Buffer[] = [], bridgeErr: Buffer[] = [];
let ansiBytes = 0, bridgeBytes = 0, rawBytes = 0, rawErrBytes = 0, bridgeErrBytes = 0;
let root: string | undefined, fixture: Fixture | undefined, terminal: Terminal | undefined;
let bridge: ChildProcessWithoutNullStreams | undefined, raw: ChildProcessWithoutNullStreams | undefined;
let bridgeFence: ChildFence | undefined, rawFence: ChildFence | undefined;
let exitFrame: Frame | undefined, readyFrame: Frame | undefined;
let bridgeExit: { code: number | null; signal: string | null } | undefined;
let rawExit: { code: number | null; signal: string | null } | undefined;
let render = Promise.resolve(), asyncError: Error | undefined, cursorVisible = true, pasteEnabled = false;
let source: unknown, sourceFingerprint = '', distFingerprint = '', failure: string | undefined;
let currentScenario = 0;
const teardown: Record<string, unknown> = {};
function artifact(name: string, value: unknown, binary = false) {
    const data = binary ? value as Buffer : Buffer.from(JSON.stringify(value, null, 2) + '\n');
    assert.ok(data.length <= LIMITS.streamBytes, `${name}: evidence overflow`);
    fs.writeFileSync(path.join(evidence, name), data, { flag: 'wx' });
    return name;
}
function check(name: string, fn: () => void) { fn(); checks.push({ name, capturedAt: new Date().toISOString() }); }
function git(...argv: string[]) {
    const result = spawnSync('git', ['-C', repo, ...argv], { encoding: 'utf8', timeout: 2000, maxBuffer: LIMITS.bodyBytes });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function fingerprint(paths: string[]) {
    const hash = createHash('sha256'); let newest = 0, files = 0;
    function add(relative: string) {
        const absolute = path.join(repo, relative), stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) { hash.update(relative + '\0' + fs.readlinkSync(absolute)); return; }
        if (stat.isDirectory()) { for (const child of fs.readdirSync(absolute).sort()) add(path.join(relative, child)); return; }
        files++; newest = Math.max(newest, stat.mtimeMs);
        hash.update(relative + '\0'); hash.update(fs.readFileSync(absolute));
    }
    for (const relative of paths) add(relative);
    return { sha256: hash.digest('hex'), newest, files };
}
const sourcePaths = ['bin', 'src', 'lib', 'types', 'server.ts', 'prompts', 'scripts/atomic-build.sh', 'tsconfig.json', 'package.json', 'package-lock.json'];
function envFor(owned: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: 'en_US.UTF-8', TERM: 'xterm-256color', CI: '1', NO_COLOR: '1',
        CLI_JAW_SKIP_AUTOMATION_PRIME: '1', JAW_OPEN_BROWSER: '0', JAW_DASHBOARD_OPEN: '0',
        JAW_SKILLS_SOURCE: 'local', TSX_DISABLE_CACHE: '1', npm_config_offline: 'true' };
    for (const key of ['HOME', 'CLI_JAW_HOME', 'TMPDIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR',
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CLI_JAW_DASHBOARD_HOME', 'npm_config_cache']) {
        const dir = path.join(owned, key); fs.mkdirSync(dir); env[key] = dir;
    }
    return env;
}
function rows(all = false) {
    if (!terminal) return [];
    const buffer = terminal.buffer.active;
    return Array.from({ length: all ? buffer.length : terminal.rows }, (_, i) =>
        buffer.getLine((all ? 0 : buffer.viewportY) + i)?.translateToString(true) ?? '');
}
const screen = () => rows().join('\n');
// The collapsed preview footer also says "F6 opens retained Activity history."
// Only the modal's heading, not that background hint, denotes an open inspector.
const historyOpen = () => rows().some(row => row.trimStart().startsWith('Activity history'));
async function until(predicate: () => boolean, label: string, allowExited = false, timeout = LIMITS.readyMs) {
    const end = Math.min(deadline, Date.now() + timeout);
    while (Date.now() < end) {
        await render;
        if (asyncError) throw asyncError;
        if (fixture?.errors.length) throw Error(fixture.errors.join('; '));
        if (predicate()) return;
        if (!allowExited && (exitFrame || bridgeExit)) throw Error(`CLI/bridge exited before ${label}: ${JSON.stringify(exitFrame ?? bridgeExit)}`);
        await poll(20); // bounded observation polling, never sleep-as-success
    }
    throw Error(`timeout ${label}\n${screen()}`);
}
async function shot(name: string) {
    await render;
    assert.ok(terminal);
    const buffer = terminal.buffer.active;
    const cells = Array.from({ length: terminal.rows }, (_, y) => {
        const line = buffer.getLine(buffer.viewportY + y);
        return Array.from({ length: terminal!.cols }, (_, x) => {
            const cell = line?.getCell(x); return [cell?.getChars() ?? '', cell?.getWidth() ?? 1];
        });
    });
    return artifact(`${name}.cells.json`, { capturedAt: new Date().toISOString(), sourceSnapshotAt: source,
        columns: terminal.cols, height: terminal.rows, byteOffset: ansiBytes, rows: rows(), cells,
        cursor: { x: buffer.cursorX, y: buffer.cursorY, visible: cursorVisible }, pasteEnabled });
}
function command(value: object) {
    assert.ok(bridge && !bridgeExit && !exitFrame, 'bridge command after exit');
    const data = Buffer.from(JSON.stringify(value)); assert.ok(data.length <= LIMITS.frameBytes);
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length);
    assert.ok(bridge.stdin.writableLength + data.length + 4 <= LIMITS.bodyBytes, 'bridge input backpressure');
    bridge.stdin.write(Buffer.concat([prefix, data]));
}
const input = (text: string) => command({ type: 'input', data: Buffer.from(text).toString('base64') });
function accept(frame: Frame) {
    assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame), 'bridge object frame');
    assert.ok(!exitFrame, 'bridge frame after exit');
    if (frame.type === 'ready') { assert.ok(!readyFrame); assert.ok(Number.isInteger(frame.pid)); readyFrame = frame; }
    else if (frame.type === 'output') {
        assert.equal(typeof frame.data, 'string');
        const chunk = Buffer.from(frame.data!, 'base64');
        assert.equal(chunk.toString('base64'), frame.data);
        ansiBytes += chunk.length; assert.ok(ansiBytes <= LIMITS.streamBytes, 'PTY stream overflow'); ansi.push(chunk);
        render = render.then(() => new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('xterm write callback exceeded 2s')), LIMITS.httpMs);
            terminal!.write(chunk, () => { clearTimeout(timer); resolve(); });
        }));
        // Attach immediately: an async renderer failure must reach the normal
        // evidence/teardown path, never become an unhandled rejection.
        void render.catch(error => { asyncError = error instanceof Error ? error : Error(String(error)); });
    } else if (frame.type === 'resize') {
        assert.equal(frame.offset, ansiBytes, 'OS resize byte boundary');
        assert.ok(frame.rows && frame.columns);
        sizes.push({ offset: frame.offset!, columns: frame.columns!, rows: frame.rows! });
        render = render.then(() => { terminal!.resize(frame.columns!, frame.rows!); });
    } else if (frame.type === 'exit') { exitFrame = frame; }
    else throw Error(`unknown bridge output ${frame.type}`);
}
function count(pathname: string, method = 'GET') { return fixture!.requests.filter(row => row.method === method && row.path.split('?')[0] === pathname).length; }
function activityReads() { return fixture!.requests.filter(row => row.method === 'GET' && /snapshot|activity|by-trace/.test(row.path)).length; }
function physicalCount(text: string) { return rows(true).filter(row => row.includes(text)).length; }
function complete(index: number, artifacts: string[]) { verdicts[index]!.verdict = 'PASS'; verdicts[index]!.artifacts = artifacts; }
function errorOf(error: unknown) { return error instanceof Error ? error.stack ?? error.message : String(error); }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e; } }
const hardTimer = setTimeout(() => {
    asyncError = Error('whole attempt deadline');
    requestFixtureDeadline(bridgeFence, rawFence);
}, LIMITS.wholeMs - 10_000);
const onSignal = () => { asyncError = Error('harness interrupted'); };
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);

try {
    assert.notEqual(process.platform, 'win32', 'unsupported host: POSIX Python PTY required');
    const head = git('rev-parse', 'HEAD');
    assert.equal(head, options.get('--built-head'), 'compiled HEAD must be explicit and current');
    const buildPath = path.resolve(options.get('--build-report') ?? '');
    const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
    assert.deepEqual(build.command, ['npm', 'run', 'build', '--ignore-scripts']);
    for (const [key, expected] of Object.entries({ exitCode: 0, timedOut: false, overflow: false, groupLive: false, rootRemoved: true }))
        assert.equal(build[key], expected, `build receipt ${key}`);
    const sources = fingerprint(sourcePaths), compiled = fingerprint(['dist']);
    assert.ok(sources.newest <= fs.statSync(buildPath).mtimeMs, 'source newer than build receipt');
    assert.ok(compiled.newest <= fs.statSync(buildPath).mtimeMs, 'dist changed since build receipt');
    sourceFingerprint = sources.sha256; distFingerprint = compiled.sha256;
    source = { kind: 'resolved', commitSha: head, branch: git('branch', '--show-current'),
        capturedAt: new Date().toISOString(), productionDirty: git('status', '--porcelain', '--', ...sourcePaths) !== '',
        sourceHash: sources.sha256, distHash: compiled.sha256, sourceFiles: sources.files, compiledFiles: compiled.files,
        entryHash: createHash('sha256').update(fs.readFileSync(path.join(repo, 'dist/bin/cli-jaw.js'))).digest('hex'),
        buildReport: buildPath, buildReportHash: createHash('sha256').update(fs.readFileSync(buildPath)).digest('hex') };
    artifact('source.json', source);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp37-pty-runtime-'));
    const env = envFor(root);
    const python = spawnSync('/usr/bin/env', ['python3', '-c', 'import pty,termios,fcntl,os; print(os.path.realpath(__import__("sys").executable))'],
        { env, cwd: root, encoding: 'utf8', timeout: 2000, maxBuffer: LIMITS.frameBytes });
    assert.equal(python.status, 0, `Python/POSIX unavailable: ${python.stderr}`);
    const pythonPath = python.stdout.trim(); assert.ok(path.isAbsolute(pythonPath));
    // A failed ABI probe must stop here, BEFORE compiled CLI's auto-repair guard.
    const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();
    const xterm = require('@xterm/xterm') as typeof import('@xterm/xterm');
    terminal = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 5000 });
    for (const final of ['h', 'l']) terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
        if (params.includes(25)) cursorVisible = final === 'h';
        if (params.includes(2004)) pasteEnabled = final === 'h';
        return false;
    });
    fixture = await createActivityFixture(root);
    const cli = path.join(repo, 'dist/bin/cli-jaw.js');
    artifact('invocation.json', { controller: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
        bridge: [pythonPath, path.join(repo, 'tests/fixtures/tui-pty-bridge.py'), process.execPath, cli, root, String(fixture.port)],
        compiledCli: [process.execPath, cli, 'chat', '--port', String(fixture.port)], env, limits: LIMITS,
        scope: 'fixture/SSE/OS PTY, not real provider or durable backend persistence' });
    // Negative fixture contract probes. These are not production authorization tests.
    for (const suffix of [`/api/traces/${RUN_A}/activity?session=wrong`, `/api/messages/by-trace/${RUN_A}?session=wrong`,
        '/api/traces/activity-runs?session=wrong', '/api/unexpected-pty-probe']) {
        const response: Response = await fetch(`http://127.0.0.1:${fixture.port}${suffix}`, { signal: AbortSignal.timeout(LIMITS.httpMs) });
        assert.equal(response.status, 404); const body = await response.json() as { ok: boolean }; assert.equal(body.ok, false);
    }
    const negativeCount = fixture.requests.length;
    bridge = spawn(pythonPath, ['-B', path.join(repo, 'tests/fixtures/tui-pty-bridge.py'), process.execPath, cli, root, String(fixture.port)],
        { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    bridgeFence = fixtureChildFence(bridge);
    let pending = Buffer.alloc(0);
    bridge.on('error', error => { asyncError = error; });
    bridge.stdin.on('error', error => { if (!exitFrame) asyncError = error; });
    bridge.on('close', (code, signal) => { bridgeExit = { code, signal }; if (pending.length) asyncError = Error('truncated bridge frame'); });
    bridge.stdout.on('data', (chunk: Buffer) => {
        try {
            bridgeBytes += chunk.length; assert.ok(bridgeBytes <= 2 * LIMITS.streamBytes, 'framed bridge byte limit');
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 4) {
                const length = pending.readUInt32BE(); assert.ok(length >= 2 && length <= LIMITS.frameBytes, 'bridge frame size');
                if (pending.length < length + 4) break;
                accept(JSON.parse(pending.subarray(4, length + 4).toString('utf8')) as Frame);
                pending = pending.subarray(length + 4);
            }
            assert.ok(pending.length <= LIMITS.frameBytes + 4, 'bridge parser buffer');
        } catch (error) { asyncError = error instanceof Error ? error : Error(String(error)); }
    });
    bridge.stderr.on('data', (chunk: Buffer) => {
        bridgeErrBytes += chunk.length;
        if (bridgeErrBytes > LIMITS.streamBytes) asyncError = Error('bridge stderr overflow'); else bridgeErr.push(chunk);
    });
    await until(() => Boolean(readyFrame) && screen().includes('F6 history') && fixture!.clientCount === 1, 'compiled composer ready');
    const ready = await shot('01-ready');
    input('Inspect the fixture\r');
    await until(() => count('/api/message', 'POST') === 1, 'exact message POST');
    check('P8.1 exact prompt', () => assert.deepEqual(fixture!.requests.find(row => row.path === '/api/message')!.body, { prompt: 'Inspect the fixture' }));
    fixture.event(RUN_A, 1, 'turn-start', { provider: 'codex-app' });
    fixture.event(RUN_A, 7, 'tool', { itemId: 'read-1', name: 'Read', status: 'running', input: '한글/👩‍💻-file.ts', output: 'PTY_TOOL_DETAIL' });
    await until(() => screen().includes('Activity') && screen().includes('Read'), 'live Activity');
    check('P8.1 initially collapsed', () => assert.ok(!screen().includes('PTY_TOOL_DETAIL')));
    input('\x0f'); await until(() => screen().includes('PTY_TOOL_DETAIL'), 'Ctrl+O disclosure');
    const expanded = await shot('01-expanded');
    input('\x1b'); await until(() => count('/api/stop', 'POST') === 1, 'Escape Stop');
    check('P8.1 Stop current live owner', () => assert.equal(fixture!.requests.find(row => row.path === '/api/stop')!.activeRun, RUN_A));
    complete(0, [ready, expanded]);

    currentScenario = 1;
    const connections = fixture.connections;
    const savedPathA = `/api/messages/by-trace/${RUN_A}`;
    const readsBefore = count(savedPathA);
    fixture.disconnect();
    fixture.event(RUN_A, 9, 'tool', { itemId: 'read-1', name: 'Read', status: 'done', output: 'OFFLINE_TOOL_DETAIL' }, false);
    const answerA = 'SAVED_EXACT_FINAL\n한글 👩‍💻\nSAVED_A_TAIL';
    fixture.save(RUN_A, answerA);
    fixture.event(RUN_A, 13, 'turn-end', { status: 'stopped', finalText: 'JOURNAL_ONLY_NOT_ANSWER' }, false);
    await until(() => fixture!.connections === connections + 1 && screen().includes('SAVED_A_TAIL'), 'SSE reconnect saved answer');
    check('P8.2 saved read once on recovery', () => assert.equal(count(savedPathA) - readsBefore, 1));
    check('P8.2 physical saved rows, not journal', () => {
        assert.equal(physicalCount('SAVED_EXACT_FINAL'), 1); assert.equal(physicalCount('SAVED_A_TAIL'), 1);
        assert.ok(rows(true).some(row => row.includes('한글 👩‍💻')));
        assert.ok(!rows(true).join('\n').includes('JOURNAL_ONLY_NOT_ANSWER'));
    });
    fixture.emit({ type: 'agent_done', ...OWNER, traceRunId: RUN_A, runtimeFinality: 'present', runtimeStatus: 'stopped', text: 'COMPAT_DIFFERENT' });
    input('draft'); await until(() => screen().includes('draft'), 'post-duplicate draft barrier');
    check('P8.2 duplicate terminal keeps one saved answer without compatibility substitution', () => {
        assert.equal(physicalCount('SAVED_EXACT_FINAL'), 1);
        assert.doesNotMatch(rows(true).join('\n'), /COMPAT_DIFFERENT/);
    });
    complete(1, [await shot('02-reconnected')]);

    currentScenario = 2;
    input('\x1b[17~'); await until(() => screen().includes('Activity history') && screen().includes('seq 7'), 'F6 retained records');
    // Wait for independent MESSAGE load and completed discovery, not a timer.
    await until(() => count(savedPathA) === readsBefore + 2 && !screen().includes('Loading'), 'F6 reads settled');
    input('\x1b[B\r\x1b[6~'); await until(() => screen().includes('OFFLINE_TOOL_DETAIL') && screen().includes('seq 9'), 'select offline seq9 detail');
    const historyShots = [await shot('03-history-detail')];
    const beforeResize = activityReads();
    for (const [columns, height] of [[20, 20], [40, 24], [80, 24], [120, 30]]) {
        const offset = ansiBytes;
        command({ type: 'resize', columns, rows: height });
        const border = '┌' + '─'.repeat(columns! - 2) + '┐';
        await until(() => terminal!.cols === columns && ansiBytes > offset && screen().includes(border)
            && screen().includes('Activity history') && screen().includes('seq 9'), `OS resize ${columns}`);
        check(`P8.3 ${columns} cells/cursor/GET`, () => {
            assert.equal(terminal!.rows, height); assert.equal(cursorVisible, false); assert.equal(activityReads(), beforeResize);
            assert.ok(rows().every(row => !row.includes('\ufffd')), 'replacement glyph');
        });
        historyShots.push(await shot(`03-resize-${columns}`));
    }
    complete(2, historyShots);

    currentScenario = 3;
    const beforePosts = fixture.requests.filter(row => row.method === 'POST').length;
    fixture.event(RUN_B, 1, 'turn-start', { provider: 'codex-app' });
    for (let i = 0; i < 150; i++) fixture.event(RUN_B, i + 2, 'tool', {
        itemId: `stress-${i}`, name: 'Read', status: 'done', input: '한글/👩‍💻-file.ts',
        output: 'x'.repeat(1000) + '\x1b]52;c;HIDDEN_CONTROL\x07',
    });
    fixture.save(RUN_B, 'STRESS_SAVED_FINAL\nSTRESS_SAVED_TAIL');
    fixture.event(RUN_B, 160, 'turn-end', { status: 'done', finalText: 'STRESS_JOURNAL_ONLY' });
    fixture.emit({ type: 'agent_done', ...OWNER, traceRunId: RUN_B, runtimeFinality: 'present', runtimeStatus: 'done', text: 'STRESS_COMPAT_DIFFERENT' });
    await until(() => count(`/api/messages/by-trace/${RUN_B}`) === 1 && screen().includes('idle'), 'stress settlement while F6 open');
    check('P8.4 selection not stolen', () => { assert.match(screen(), new RegExp(RUN_A)); assert.match(screen(), /seq 9/); });
    const stressHistory = await shot('04-stress-history');
    input('\x1b[200~evil\r\x03\x1b[201~\x1b');
    await until(() => !historyOpen() && screen().includes('draft'), 'paste drained, Escape preserves draft');
    await until(() => screen().includes('STRESS_SAVED_TAIL') && rows(true).join('\n').includes('Preview limited'), 'bounded preview and full saved final');
    check('P8.4 controls cannot POST', () => { assert.equal(count('/api/message', 'POST'), 1); assert.equal(count('/api/stop', 'POST'), 1);
        assert.equal(fixture!.requests.filter(row => row.method === 'POST').length, beforePosts); });
    check('P8.4 controls/journal not rendered; exact final once', () => {
        const cells = rows(true).join('\n'); assert.doesNotMatch(cells, /HIDDEN_CONTROL|STRESS_JOURNAL_ONLY|STRESS_COMPAT_DIFFERENT/);
        assert.equal(physicalCount('STRESS_SAVED_FINAL'), 1); assert.equal(physicalCount('STRESS_SAVED_TAIL'), 1);
        assert.equal(fixture!.state().runs.find(run => run.id === RUN_B)!.events.filter(event => event.kind === 'tool').length, 150);
    });
    input('!'); await until(() => screen().includes('draft!'), 'draft cursor preserved');
    complete(3, [stressHistory, await shot('04-stress-draft')]);

    currentScenario = 4;
    input('\x03');
    await until(() => Boolean(exitFrame && bridgeExit), 'idle Ctrl+C reap', true);
    await render;
    check('P8.5 terminal restore and owned child reap', () => {
        assert.equal(exitFrame!.code, 0); assert.equal(exitFrame!.error, null); assert.equal(bridgeExit!.code, 0);
        assert.equal(exitFrame!.reaped, true); assert.equal(exitFrame!.groupLive, false); assert.equal(exitFrame!.fdsClosed, true);
        assert.equal(exitFrame!.ownershipUnknown, false); assert.ok(exitFrame!.authorityRevoked);
        assert.equal(exitFrame!.termiosRestored, true); assert.deepEqual(exitFrame!.forced, []);
        assert.equal(cursorVisible, true); assert.equal(pasteEnabled, false);
        assert.equal(alive(readyFrame!.pid!), false);
        const output = Buffer.concat(ansi).toString('utf8');
        assert.ok(output.lastIndexOf('\x1b[?25h') > output.lastIndexOf('\x1b[?25l'));
        assert.ok(output.lastIndexOf('\x1b[?2004l') > output.lastIndexOf('\x1b[?2004h'));
    });
    complete(4, [artifact('05-exit.json', { exitFrame, bridgeExit }), await shot('05-exited')]);

    currentScenario = 5;
    const beforeRaw = activityReads();
    raw = spawn(process.execPath, [cli, 'chat', '--port', String(fixture.port), '--raw'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    rawFence = fixtureChildFence(raw);
    raw.on('error', error => { asyncError = error; }); raw.stdin.on('error', error => { asyncError = error; });
    raw.on('close', (code, signal) => { rawExit = { code, signal }; });
    raw.stdout.on('data', (chunk: Buffer) => { rawBytes += chunk.length; if (rawBytes > LIMITS.streamBytes) asyncError = Error('raw stdout overflow'); else rawOut.push(chunk); });
    raw.stderr.on('data', (chunk: Buffer) => { rawErrBytes += chunk.length; if (rawErrBytes > LIMITS.streamBytes) asyncError = Error('raw stderr overflow'); else rawErr.push(chunk); });
    raw.stdin.end('{"type":"message","text":"raw probe"}\n');
    await until(() => count('/api/message', 'POST') === 2 && fixture!.clientCount === 1, 'raw prompt', true);
    const unknown = { type: 'agent_runtime', version: 999, runId: 'raw', sessionId: 'raw', scope: 'raw',
        turnId: 'raw', seq: 1, kind: 'message', text: '\x1b]52;c;secret\x07漢字' };
    const rawEnd = { type: 'agent_done', text: 'RAW_FINAL' };
    fixture.emit(unknown); fixture.emit(rawEnd);
    await until(() => Boolean(rawExit), 'raw clean exit', true);
    check('P8.6 exact unknown NDJSON, no Activity GET', () => {
        assert.equal(rawExit!.code, 0); assert.equal(Buffer.concat(rawOut).toString('utf8'), JSON.stringify(unknown) + '\n' + JSON.stringify(rawEnd) + '\n');
        assert.ok(!Buffer.concat(rawOut).includes(0x1b)); assert.equal(activityReads(), beforeRaw); assert.equal(rawErrBytes, 0);
    });
    check('no unexpected fixture requests', () => assert.ok(fixture!.requests.slice(negativeCount).every(row => row.status === 200)));
    complete(5, ['raw-output.ndjson', 'raw-stderr.txt']);
    check('build/source unchanged through all scenarios', () => {
        assert.equal(fingerprint(sourcePaths).sha256, sourceFingerprint); assert.equal(fingerprint(['dist']).sha256, distFingerprint);
        assert.equal(git('rev-parse', 'HEAD'), options.get('--built-head'));
    });
} catch (error) {
    failure = errorOf(error); verdicts[currentScenario]!.verdict = 'FAIL'; verdicts[currentScenario]!.detail = failure;
    verdicts[currentScenario]!.artifacts.push('pty-output.ansi', 'fixture-state.json');
    if (terminal) { try { await shot('failure'); } catch (captureError) { failure += '\n' + errorOf(captureError); } }
} finally {
    const cleanupErrors: string[] = [];
    try {
        if (bridge && !bridgeExit) { if (!exitFrame) { try { command({ type: 'exit' }); } catch { bridgeFence?.signal('SIGTERM'); } }
            const end = Date.now() + 8000; while (!bridgeExit && Date.now() < end) await poll(20);
            await waitExit(bridgeFence!, () => Boolean(bridgeExit), 'bridge'); }
        if (bridge) {
            const numericPidPresent = bridge.pid ? alive(bridge.pid) : null;
            teardown.bridge = { pid: bridge.pid, bridgeExit, exitFrame, numericPidPresent };
            if (!exitFrame?.reaped || !exitFrame.fdsClosed || fixtureOwnershipError(exitFrame)
                || numericPidPresent !== false || (readyFrame?.pid && alive(readyFrame.pid)))
                throw Error('PTY child/fd cleanup or post-reap numeric ownership unknown (not signalled)');
        }
    } catch (error) { cleanupErrors.push(errorOf(error)); }
    try {
        if (raw) { await waitExit(rawFence!, () => Boolean(rawExit), 'raw');
            const ownership = rawFence!.observeGroup(); // diagnostic ONLY after child-handle reap
            teardown.raw = { pid: raw.pid, ...rawExit, ...ownership };
            const issue = fixtureOwnershipError(ownership);
            if (issue) throw Error(`raw ${issue}`); }
    } catch (error) { cleanupErrors.push(errorOf(error)); }
    try { artifact('fixture-state.json', fixture ? fixture.state() : { unavailable: true, reason: 'preflight failed before fixture creation' }); }
    catch (error) { cleanupErrors.push(errorOf(error)); }
    try {
        if (fixture) {
            teardown.fixture = await fixture.close();
            const closed = await new Promise<boolean>(resolve => {
                const socket = createConnection({ host: '127.0.0.1', port: fixture!.port });
                socket.setTimeout(2000); socket.once('connect', () => { socket.destroy(); resolve(false); });
                socket.once('error', error => resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
                socket.once('timeout', () => { socket.destroy(); resolve(false); });
            });
            teardown.port = fixture.port; teardown.portClosed = closed;
            if (!closed) throw Error('fixture listening port cleanup unproven');
        }
    } catch (error) { cleanupErrors.push(errorOf(error)); }
    await render.catch(error => cleanupErrors.push(errorOf(error)));
    terminal?.dispose(); bridge?.stdin.destroy(); raw?.stdin.destroy();
    Object.assign(teardown, finishFixtureRoot(root, cleanupErrors));
    clearTimeout(hardTimer); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    artifact('pty-output.ansi', Buffer.concat(ansi), true); artifact('raw-output.ndjson', Buffer.concat(rawOut), true);
    artifact('raw-stderr.txt', Buffer.concat(rawErr), true); artifact('bridge-stderr.txt', Buffer.concat(bridgeErr), true);
    artifact('resize-timeline.json', sizes); artifact('teardown.json', teardown);
    if (cleanupErrors.length) failure = (failure ?? '') + '\n' + cleanupErrors.join('\n');
    if (Date.now() - started > LIMITS.wholeMs) failure = (failure ?? '') + '\nwhole attempt exceeded 180s';
    const passed = attemptPassed(failure, verdicts.every(row => row.verdict === 'PASS'), teardown.contained === true);
    const result = { passed, failure, scope: 'fixture/SSE/OS PTY, not real provider or durable backend persistence',
        capturedAt: new Date().toISOString(), elapsedMs: Date.now() - started, sourceSnapshotAt: source,
        verdicts, checks, limits: LIMITS, bytes: { pty: ansiBytes, bridgeFramed: bridgeBytes, raw: rawBytes, rawErr: rawErrBytes, bridgeErr: bridgeErrBytes },
        teardown, evidence };
    artifact('result.json', result);
    console.log(JSON.stringify({ passed, scenarios: verdicts.map(row => `${row.scenario}:${row.verdict}`), checks: checks.length, elapsedMs: result.elapsedMs, evidence, failure }));
    if (!passed) process.exitCode = 1;
}
