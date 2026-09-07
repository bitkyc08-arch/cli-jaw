// Actual copied bundler/checkers; only external download/npm/native/smoke commands
// are modeled. This certifies transaction ownership, NOT a runnable real package.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const target = [process.platform, process.arch];
const supported = ['darwin-arm64', 'darwin-x64', 'linux-x64'].includes(target.join('-'));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

// Every fake command exits or consumes its single bounded stdin request. No
// network, provider CLI, native addon or application server is ever delegated.
const fakeCommands = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const [command, ...a] = process.argv.slice(2);
const root = process.env.FIXTURE_ROOT;
const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
const log = entry => fs.appendFileSync(path.join(root, 'commands.jsonl'), JSON.stringify(entry) + '\n');
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); };
const ownerPath = path.join(root, 'project/electron/sidecar/.server-build.lock/owner.json');
const owner = () => JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
const identity = p => { const s = fs.lstatSync(p); return s.dev + ':' + s.ino; };
const changeRuntime = (stage, phase) => {
  const file = path.join(stage, 'dist/server.js');
  const before = fs.readFileSync(file, 'utf8'), stageBefore = identity(stage), fileBefore = identity(file);
  if (before !== 'export {};') throw Error('unexpected checked runtime bytes');
  fs.writeFileSync(file, "throw new Error('changed after check');");
  log({ command: 'runtime-change', phase, before, after: fs.readFileSync(file, 'utf8'),
    stageBefore, stageAfter: identity(stage), fileBefore, fileAfter: identity(file), sourceSha256: owner().sourceSha256 });
};
const run = (source, argv) => { process.argv = argv; const filename = path.join(root, 'eval.cjs'); const m = new Module(filename); m.paths = module.paths; m._compile(source, filename); };
if (command === 'curl') {
  log({ command, args: a });
  if (mode === 'download-fail') process.exit(23);
  fs.copyFileSync(path.join(root, 'node.tar.gz'), a[a.indexOf('-o') + 1]);
} else if (command === 'npm') {
  log({ command, args: a, cwd: process.cwd() });
  if (mode === 'install-fail') process.exit(41);
  if (a[0] === 'ci') {
    if (!a.includes('--ignore-scripts')) throw Error('lifecycle not disabled');
    write(path.resolve('node_modules/better-sqlite3/package.json'), JSON.stringify({ name: 'better-sqlite3', version: '13.0.2' }));
    fs.mkdirSync(path.resolve('node_modules/.bin'), { recursive: true });
    if (mode === 'no-jwc-fail' && a.includes('--omit=dev')) fs.mkdirSync(path.resolve('node_modules/bun'));
    if (mode === 'payload-dangling-link' && a.includes('--omit=dev'))
      fs.symlinkSync('../lib/node_modules/cli-jaw/dist/bin/cli-jaw.js', path.resolve('bin/cli-jaw'));
    if (mode === 'dependency-link' && a.includes('--omit=dev')) {
      fs.renameSync(path.resolve('node_modules'), path.resolve('original-modules'));
      write(path.join(root, 'foreign-deps/react/sentinel'), 'do not prune');
      fs.symlinkSync(path.join(root, 'foreign-deps'), path.resolve('node_modules'));
    }
  } else if (a.join(' ') === 'run build --ignore-scripts') {
    if (mode === 'build-fail') process.exit(42);
    write(path.resolve('dist/server.js'), 'export {};');
    write(path.resolve('dist/src/telegram/bot.js'), 'export {};');
    write(path.resolve('dist/src/manager/server.js'), 'export {};');
    write(path.resolve('dist/bin/cli-jaw.js'), 'export {};');
    if (mode === 'asset-missing' || mode === 'asset-present') {
      write(path.resolve('dist/literal-asset.js'), "export const load = () => import('./required-sidecar.mjs');");
      if (mode === 'asset-present') write(path.resolve('dist/required-sidecar.mjs'), 'export {};');
    }
  } else if (a.join(' ') === 'run build:frontend --ignore-scripts') {
    write(path.resolve('public/dist/index.html'), 'owned frontend');
  } else if (a.join(' ') === 'run build-release --foreground-scripts') {
    if (mode === 'native-fail') process.exit(43);
  } else throw Error('unexpected npm invocation: ' + a);
} else if (command === 'node' && a[0] === '--input-type=commonjs' && a[1] === '-') {
  const source = fs.readFileSync(0, 'utf8');
  if (a[2] === 'capture' && mode === 'capture-repeated') {
    const state = owner(); state.runtimePayloadSha256 = '0'.repeat(64);
    fs.writeFileSync(ownerPath, JSON.stringify(state));
  }
  if (a[2] === 'gated' || a[2] === 'complete') log({ command: 'payload-check', phase: a[2],
    runtimePayloadSha256: owner().runtimePayloadSha256, sourceSha256: owner().sourceSha256 });
  if (mode === 'promotion-fail' && a[2] === 'promote') {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === path.join(root, 'project/electron/sidecar/server')) throw Error('fixture promotion failure');
      return rename(from, to);
    };
  }
  run(source, [process.execPath, '-', ...a.slice(2)]);
} else if (command === 'node' && a[0]?.endsWith('check-sidecar-smoke.mjs')) {
  log({ command: 'smoke', args: a.slice(1) });
  const stage = a[a.indexOf('--server-root') + 1], report = a[a.indexOf('--report') + 1];
  if (a.length !== 5 || !stage.endsWith('/server') || path.dirname(stage) !== path.dirname(report)) throw Error('gate interface changed');
  if (fs.existsSync(path.join(stage, '.jaw-install-state.json')) || fs.existsSync(path.join(stage, '.jaw-sidecar-build.json'))) throw Error('premature receipt');
  log({ command: 'payload-check', phase: 'smoke', runtimePayloadSha256: owner().runtimePayloadSha256,
    sourceSha256: owner().sourceSha256, stageIdentity: identity(stage) });
  if (mode === 'report-fail') { fs.mkdirSync(report); process.exit(44); }
  fs.writeFileSync(report, JSON.stringify({ fixtureGate: true, ok: mode !== 'smoke-fail' }), { flag: 'wx' });
  if (mode === 'smoke-fail') process.exit(45);
  if (mode === 'runtime-smoke-change') changeRuntime(stage, 'smoke');
  if (mode === 'capture-missing' || mode === 'capture-malformed') {
    const state = owner();
    if (mode === 'capture-missing') delete state.runtimePayloadSha256;
    else state.runtimePayloadSha256 = ['not-a-digest'];
    fs.writeFileSync(ownerPath, JSON.stringify(state));
  }
  if (mode === 'source-change') fs.appendFileSync(path.join(root, 'project/server.ts'), '\n// concurrent edit');
  if (mode === 'source-link-change') {
    // This is the test-owned source, never the real checkout's launcher.
    const link = path.join(root, 'project/bin/cli-jaw');
    fs.unlinkSync(link); fs.symlinkSync('../lib/node_modules/cli-jaw/dist/bin/other.js', link);
  }
  if (mode === 'late-output') write(path.join(root, 'project/electron/sidecar/server/foreign'), 'untouched');
  if (mode === 'stage-swap') {
    fs.renameSync(stage, stage + '-original'); fs.mkdirSync(stage);
    write(path.join(stage, 'foreign'), 'untouched');
  }
  if (mode === 'unknown-extraction') {
    const extraction = fs.readdirSync(path.join(root, 'tmp'))[0];
    write(path.join(root, 'tmp', extraction, 'foreign'), 'untouched');
  }
  if (mode === 'interrupt' || mode === 'hold') {
    process.stdout.write('FIXTURE_GATE_WAITING\n');
    // One acknowledged release; a finite deadline fails, never silently succeeds.
    const timer = setTimeout(() => process.exit(46), 8000);
    process.stdin.once('data', () => { clearTimeout(timer); process.exit(mode === 'hold' ? 0 : 47); });
    process.stdin.resume();
  }
} else if (command === 'node' && /check-(sidecar-prune-safety.mjs|electron-sidecar-no-jwc.cjs)$/.test(a[0] || '')) {
  // Execute the actual copied checker, not a rewritten test equivalent.
  if (a[0].endsWith('check-electron-sidecar-no-jwc.cjs') && mode.startsWith('premature-')) {
    const metadata = mode === 'premature-install' ? '.jaw-install-state.json' : '.jaw-sidecar-build.json';
    write(path.join(a[a.indexOf('--server-root') + 1], metadata), '{}');
  }
  const checked = require('node:child_process').spawnSync(process.execPath, a, { stdio: 'inherit', timeout: 10000 });
  if (checked.error) { console.error(checked.error); process.exit(1); }
  process.exit(checked.status ?? 1);
} else if (command === 'native' && a[0] === '-e') {
  log({ command: 'native', args: a });
  if (a[1].includes('p.scripts&&p.scripts.install')) process.stdout.write('no');
  else if (a[1].includes("new Database(':memory:')")) { if (mode === 'native-fail') process.exit(43); }
  else if (a[1].includes('.jaw-install-state.json')) {
    // This subprocess models the archive's pinned Node, not the test host.
    // Evaluate the actual receipt code; transaction/checker processes stay native.
    Object.defineProperty(process, 'version', { value: mode === 'wrong-native-version' ? 'v22.0.0' : 'v24.17.0' });
    run(a[1], [process.execPath, ...a.slice(2)]);
    if (mode === 'runtime-receipt-change') changeRuntime(a[2], 'receipt');
  }
  else throw Error('unexpected native invocation');
} else throw Error('unapproved fixture command: ' + command + ' ' + a);
`;

function fixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-bundle-owned-')));
    const project = path.join(root, 'project');
    const parent = path.join(project, 'electron/sidecar');
    const put = (rel: string, value: string) => {
        const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value);
    };
    fs.mkdirSync(path.join(parent, 'jawcode'), { recursive: true });
    put('project/electron/sidecar/jawcode/sentinel', 'unrelated jawcode');
    put('outside-sentinel', 'unrelated tmp');
    put('mode', 'pass'); put('commands.jsonl', ''); put('commands.cjs', fakeCommands);
    put('project/package.json', JSON.stringify({ name: 'cli-jaw', version: '2.17.38', type: 'module' }));
    put('project/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'cli-jaw', version: '2.17.38' } } }));
    put('project/server.ts', 'export {};'); put('project/public/index.html', 'fixture input');
    for (const file of ['bundle-sidecar.sh', 'check-sidecar-prune-safety.mjs', 'check-electron-sidecar-no-jwc.cjs', 'verify-dist-assets.sh']) {
        fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
        fs.copyFileSync(path.join(repo, 'scripts', file), path.join(project, 'scripts', file));
    }
    // Gate is intercepted at the command boundary, never imported in the fixture.
    put('project/scripts/check-sidecar-smoke.mjs', 'throw new Error("fixture must not run real smoke");');
    const wrapper = (command: string) => `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'commands.cjs'))} ${command} "$@"\n`;
    for (const command of ['node', 'npm', 'curl']) {
        put(`fake-bin/${command}`, wrapper(command)); fs.chmodSync(path.join(root, 'fake-bin', command), 0o755);
    }
    const member = `node-v24.17.0-${process.platform}-${process.arch}/bin/node`;
    put(`archive/${member}`, wrapper('native')); fs.chmodSync(path.join(root, 'archive', member), 0o755);
    const archive = spawnSync('/usr/bin/tar', ['-czf', path.join(root, 'node.tar.gz'), '-C', path.join(root, 'archive'), member],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    assert.equal(archive.status, 0, archive.stderr);
    for (const dir of ['home', 'tmp']) fs.mkdirSync(path.join(root, dir));
    const env = { PATH: `${path.join(root, 'fake-bin')}:/usr/bin:/bin`, HOME: path.join(root, 'home'),
        TMPDIR: path.join(root, 'tmp'), FIXTURE_ROOT: root, LANG: 'C' };
    let active = 0;
    const run = async (args = target, interrupt = false, onGate?: () => Promise<void>) => {
        active++;
        const child = spawn('/bin/bash', [path.join(project, 'scripts/bundle-sidecar.sh'), ...args],
            { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '', error: Error | undefined, timedOut = false, revoked = false, interrupted = false;
        child.once('exit', () => { revoked = true; });
        child.once('error', e => { error = e; revoked = true; });
        const timer = setTimeout(() => {
            timedOut = true;
            if (!revoked) child.kill('SIGTERM'); // Retained owned handle, never a numeric PID/group.
            child.stdin.end('release\n');
        }, 15_000);
        const receive = (chunk: Buffer) => {
            out += chunk.toString();
            if (out.length > 256 * 1024) { timedOut = true; if (!revoked) child.kill('SIGTERM'); child.stdin.end('release\n'); }
            if ((interrupt || onGate) && !interrupted && out.includes('FIXTURE_GATE_WAITING')) {
                interrupted = true;
                if (interrupt) assert.equal(child.kill('SIGTERM'), true);
                // The shell defers its trap until the foreground command ends.
                // Release our fake child explicitly; no descendants are signalled.
                if (onGate) void onGate().catch(e => { error = e; }).finally(() => child.stdin.end('release\n'));
                else child.stdin.end('release\n');
            }
        };
        child.stdout.on('data', receive); child.stderr.on('data', receive);
        const code = await new Promise<number | null>((resolve, reject) => {
            const boundary = setTimeout(() => {
                child.stdout.destroy(); child.stderr.destroy(); child.unref();
                reject(new Error(`fixture lifetime unknown; retain ${root}`));
            }, 20_000);
            child.once('close', code => { clearTimeout(boundary); resolve(code); });
        });
        clearTimeout(timer); active--;
        assert.equal(error, undefined); assert.equal(timedOut, false, out);
        assert.equal(fs.readFileSync(path.join(parent, 'jawcode/sentinel'), 'utf8'), 'unrelated jawcode');
        assert.equal(fs.readFileSync(path.join(root, 'outside-sentinel'), 'utf8'), 'unrelated tmp');
        return { code, out };
    };
    return { root, project, parent, put, run,
        mode: (m: string) => put('mode', m),
        output: path.join(parent, 'server'), lock: path.join(parent, '.server-build.lock'),
        builds: () => fs.readdirSync(parent).filter(n => n.startsWith('.server-build.') && n !== '.server-build.lock').map(n => path.join(parent, n)),
        commands: () => fs.readFileSync(path.join(root, 'commands.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)),
        cleanup: () => { if (active === 0) fs.rmSync(root, { recursive: true, force: true }); },
    };
}

async function owned(body: (f: ReturnType<typeof fixture>) => Promise<void>) {
    const f = fixture();
    try { await body(f); } finally { f.cleanup(); }
}

// Independent fixture-source fingerprint, excluding only the output parent;
// it does not call the bundler's sourceHash or runtime digest implementation.
function fixtureSourceBytes(project: string): string {
    const entries: unknown[] = [];
    const visit = (rel: string) => {
        if (rel === 'electron') return;
        const file = path.join(project, rel), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) entries.push([rel, stat.mode, fs.readlinkSync(file)]);
        else if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(rel, name));
        else entries.push([rel, stat.mode, fs.readFileSync(file).toString('base64')]);
    };
    visit(''); return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

test('one runtime capture survives allowed completion metadata while final seal still binds install receipt', { skip: !supported }, async () => owned(async f => {
    const before = fixtureSourceBytes(f.project);
    const r = await f.run(); assert.equal(r.code, 0, r.out);
    assert.equal(fixtureSourceBytes(f.project), before);
    const checks = f.commands().filter(c => c.command === 'payload-check');
    assert.deepEqual(checks.map(c => c.phase), ['smoke', 'gated', 'complete']);
    const captured = checks[0].runtimePayloadSha256;
    assert.match(captured, /^[a-f0-9]{64}$/);
    assert.deepEqual(checks.map(c => c.runtimePayloadSha256), [captured, captured, captured]);
    const seal = JSON.parse(fs.readFileSync(path.join(f.output, '.jaw-sidecar-build.json'), 'utf8'));
    assert.notEqual(seal.payloadSha256, captured);
    // Parsed install fields remain identical: only the final payload seal can
    // reject this whitespace edit to the otherwise permitted completion file.
    fs.appendFileSync(path.join(f.output, '.jaw-install-state.json'), '\n');
    const rejected = await f.run(); assert.notEqual(rejected.code, 0, rejected.out);
    assert.match(rejected.out, /Output provenance mismatch/);
}));

for (const phase of ['smoke', 'receipt']) test(`runtime byte change after ${phase} fails against original capture with unchanged source and stage inode`, { skip: !supported }, async () => owned(async f => {
    const before = fixtureSourceBytes(f.project);
    f.mode(`runtime-${phase}-change`); const r = await f.run();
    const commands = f.commands();
    const change = commands.find(c => c.command === 'runtime-change');
    assert.ok(change, 'the owned late finalizer must actually execute');
    assert.equal(change.before, 'export {};');
    assert.equal(change.after, "throw new Error('changed after check');");
    assert.equal(change.stageAfter, change.stageBefore);
    assert.equal(change.fileAfter, change.fileBefore);
    assert.equal(fixtureSourceBytes(f.project), before);
    const checks = commands.filter(c => c.command === 'payload-check');
    assert.deepEqual(checks.map(c => c.phase), phase === 'smoke' ? ['smoke', 'gated'] : ['smoke', 'gated', 'complete']);
    assert.equal(change.stageBefore, checks[0].stageIdentity);
    for (const check of checks) assert.equal(check.sourceSha256, change.sourceSha256);
    assert.notEqual(r.code, 0, r.out); assert.match(r.out, /Runtime payload changed after capture/);
    const build = f.builds()[0]!;
    assert.equal(fs.existsSync(path.join(build, 'smoke-report.json')), true);
    assert.equal(fs.existsSync(path.join(build, 'server/.jaw-sidecar-build.json')), false);
    assert.equal(fs.existsSync(path.join(build, 'server/.jaw-install-state.json')), phase === 'receipt');
    assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.lock), true);
    assert.doesNotMatch(r.out, /Sidecar ready/);
}));

test('missing or malformed captured runtime state cannot be refreshed after smoke', { skip: !supported }, async () => {
    for (const mode of ['capture-missing', 'capture-malformed']) await owned(async f => {
        f.mode(mode); const r = await f.run();
        assert.notEqual(r.code, 0, r.out); assert.match(r.out, /Missing or invalid runtime payload capture/);
        assert.equal(fs.existsSync(path.join(f.builds()[0]!, 'server/.jaw-install-state.json')), false);
        assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.lock), true);
    });
});

test('capture refuses existing completion metadata or an already populated baseline before smoke', { skip: !supported }, async () => {
    for (const mode of ['premature-install', 'premature-build', 'capture-repeated']) await owned(async f => {
        f.mode(mode); const r = await f.run();
        assert.notEqual(r.code, 0, r.out);
        assert.match(r.out, mode === 'capture-repeated' ? /Runtime payload already captured/ : /Completion metadata exists before smoke/);
        assert.equal(f.commands().some(c => c.command === 'smoke'), false);
        assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.lock), true);
    });
});

test('source snapshot preserves actual launcher-shaped internal links verbatim, including dangling aliases', { skip: !supported }, async () => {
    const linkText = '../lib/node_modules/cli-jaw/dist/bin/cli-jaw.js';
    for (const resolved of [false, true]) await owned(async f => {
        fs.mkdirSync(path.join(f.project, 'bin'));
        fs.symlinkSync(linkText, path.join(f.project, 'bin/cli-jaw'));
        if (resolved) f.put('project/lib/node_modules/cli-jaw/dist/bin/cli-jaw.js', 'owned launcher target');
        const r = await f.run(); assert.equal(r.code, 0, r.out);
        const copied = path.join(f.builds()[0]!, 'source/bin/cli-jaw');
        assert.equal(fs.lstatSync(copied).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(copied), linkText);
        assert.equal(fs.existsSync(copied), resolved);
        assert.equal(fs.readlinkSync(path.join(f.project, 'bin/cli-jaw')), linkText);
        if (resolved) {
            assert.equal(fs.realpathSync(copied), path.resolve(path.dirname(copied), linkText));
            assert.notEqual(fs.realpathSync(copied), fs.realpathSync(path.join(f.project, 'bin/cli-jaw')));
        }
    });
});

test('absolute, lexical-escape and realpath-escape source links fail before external work', { skip: !supported }, async () => {
    for (const mode of ['absolute', 'lexical', 'realpath']) await owned(async f => {
        fs.mkdirSync(path.join(f.project, 'bin'));
        // The indirect directory is outside the copied input catalogue, so the
        // bin alias itself must reject the resolved escape, not another scan.
        if (mode === 'realpath') fs.symlinkSync(f.root, path.join(f.project, 'redirect'));
        const target = mode === 'absolute' ? path.join(f.project, 'server.ts') :
            mode === 'lexical' ? '../../outside-sentinel' : '../redirect/outside-sentinel';
        fs.symlinkSync(target, path.join(f.project, 'bin/cli-jaw'));
        const r = await f.run(); assert.notEqual(r.code, 0, r.out);
        assert.equal(fs.readlinkSync(path.join(f.project, 'bin/cli-jaw')), target);
        assert.deepEqual(f.commands(), []); assert.equal(fs.existsSync(f.output), false);
    });
});

test('changing an admitted source link invalidates the snapshot before receipts or promotion', { skip: !supported }, async () => owned(async f => {
    fs.mkdirSync(path.join(f.project, 'bin'));
    fs.symlinkSync('../lib/node_modules/cli-jaw/dist/bin/cli-jaw.js', path.join(f.project, 'bin/cli-jaw'));
    f.mode('source-link-change'); const r = await f.run();
    assert.notEqual(r.code, 0, r.out); assert.match(r.out, /Source changed during build/);
    const build = f.builds()[0]!;
    assert.equal(fs.readlinkSync(path.join(build, 'source/bin/cli-jaw')), '../lib/node_modules/cli-jaw/dist/bin/cli-jaw.js');
    assert.equal(fs.readlinkSync(path.join(f.project, 'bin/cli-jaw')), '../lib/node_modules/cli-jaw/dist/bin/other.js');
    assert.equal(fs.existsSync(path.join(build, 'server/.jaw-install-state.json')), false);
    assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.lock), true);
}));

test('source alias admission never permits a dangling link in the output payload', { skip: !supported }, async () => owned(async f => {
    f.mode('payload-dangling-link'); const r = await f.run();
    assert.notEqual(r.code, 0, r.out); assert.match(r.out, /ENOENT/);
    assert.equal(f.commands().some(c => c.command === 'native' || c.command === 'smoke'), false);
    assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.lock), true);
}));

test('bundle argv and unsupported/mismatched host fail before effects', { skip: !supported }, async () => {
    for (const args of [[], ['darwin'], [...target, 'extra'], ['linux', 'arm64'], ['win32', 'x64']]) {
        await owned(async f => {
            const r = await f.run(args); assert.notEqual(r.code, 0, r.out);
            assert.deepEqual(f.commands(), []); assert.deepEqual(f.builds(), []); assert.equal(fs.existsSync(f.lock), false);
        });
    }
});

test('missing/malformed/mismatched/symlink lockfiles fail without staging', { skip: !supported }, async () => {
    for (const mode of ['missing', 'malformed', 'mismatch', 'symlink']) await owned(async f => {
        const lockfile = path.join(f.project, 'package-lock.json');
        fs.unlinkSync(lockfile);
        if (mode === 'malformed') fs.writeFileSync(lockfile, '{');
        if (mode === 'mismatch') fs.writeFileSync(lockfile, JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'foreign', version: '2.17.38' } } }));
        if (mode === 'symlink') fs.symlinkSync(path.join(f.project, 'package.json'), lockfile);
        assert.notEqual((await f.run()).code, 0); assert.deepEqual(f.commands(), []);
        assert.equal(fs.existsSync(f.lock), false); assert.deepEqual(f.builds(), []);
    });
});

test('existing lock, unknown output, output symlink and parent symlink are never adopted', { skip: !supported }, async () => {
    for (const mode of ['lock', 'unknown', 'symlink', 'parent']) await owned(async f => {
        if (mode === 'lock') { fs.mkdirSync(f.lock); fs.writeFileSync(path.join(f.lock, 'foreign'), 'retained'); }
        if (mode === 'unknown') { fs.mkdirSync(f.output); fs.writeFileSync(path.join(f.output, 'foreign'), 'retained'); }
        if (mode === 'symlink') fs.symlinkSync(path.join(f.parent, 'jawcode'), f.output);
        if (mode === 'parent') {
            fs.renameSync(f.parent, path.join(f.root, 'foreign-parent'));
            fs.symlinkSync(path.join(f.root, 'foreign-parent'), f.parent);
        }
        assert.notEqual((await f.run()).code, 0); assert.deepEqual(f.commands(), []); assert.deepEqual(f.builds(), []);
        if (mode === 'lock') assert.equal(fs.readFileSync(path.join(f.lock, 'foreign'), 'utf8'), 'retained');
        if (mode === 'unknown') assert.equal(fs.readFileSync(path.join(f.output, 'foreign'), 'utf8'), 'retained');
        if (mode === 'symlink') assert.equal(fs.lstatSync(f.output).isSymbolicLink(), true);
        if (mode === 'parent') assert.equal(fs.lstatSync(f.parent).isSymbolicLink(), true);
    });
});

test('every failing build gate retains its owned staging/extraction/lock without completed receipts', { skip: !supported }, async () => {
    for (const mode of ['download-fail', 'install-fail', 'build-fail', 'native-fail', 'no-jwc-fail', 'smoke-fail', 'report-fail']) await owned(async f => {
        f.mode(mode); const r = await f.run(); assert.notEqual(r.code, 0, r.out);
        assert.doesNotMatch(r.out, /Sidecar ready/); assert.equal(fs.existsSync(f.output), false);
        assert.equal(fs.existsSync(f.lock), true); assert.equal(f.builds().length, 1);
        const build = f.builds()[0]!;
        assert.equal(fs.existsSync(path.join(build, 'server/.jaw-sidecar-build.json')), false);
        assert.equal(fs.existsSync(path.join(build, 'server/.jaw-install-state.json')), false);
        assert.equal(fs.readdirSync(path.join(f.root, 'tmp')).length, 1);
        assert.notEqual((await f.run()).code, 0, 'retained lock cannot be auto-recovered');
    });
});

test('interruption waits for owned foreground release then retains roots and rejects another owner', { skip: !supported }, async () => owned(async f => {
    f.mode('interrupt'); const r = await f.run(target, true);
    assert.equal(r.code, 143, r.out); assert.equal(fs.existsSync(f.output), false);
    assert.equal(fs.existsSync(f.lock), true); assert.equal(f.builds().length, 1);
    assert.equal(fs.existsSync(path.join(f.builds()[0]!, 'smoke-report.json')), true);
    assert.notEqual((await f.run()).code, 0);
}));

test('a live bundle owner excludes a concurrent invocation before download', { skip: !supported }, async () => owned(async f => {
    f.mode('hold');
    const first = await f.run(target, false, async () => {
        const second = await f.run();
        assert.notEqual(second.code, 0); assert.match(second.out, /Output locked/);
        assert.equal(f.commands().filter(c => c.command === 'curl').length, 1);
    });
    assert.equal(first.code, 0, first.out);
}));

test('a symlink in the downloaded Node member is refused before native execution', { skip: !supported }, async () => owned(async f => {
    const member = `node-v24.17.0-${process.platform}-${process.arch}/bin/node`;
    const binary = path.join(f.root, 'archive', member);
    fs.unlinkSync(binary); fs.symlinkSync(path.join(f.root, 'outside-sentinel'), binary);
    const archive = spawnSync('/usr/bin/tar', ['-czf', path.join(f.root, 'node.tar.gz'), '-C', path.join(f.root, 'archive'), member],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    assert.equal(archive.status, 0, archive.stderr);
    const r = await f.run(); assert.notEqual(r.code, 0, r.out);
    assert.equal(f.commands().some(c => c.command === 'native'), false);
    assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.lock), true);
}));

test('successful gated promotion preserves siblings, uses fresh extraction and keeps verified old backup', { skip: !supported }, async () => owned(async f => {
    const first = await f.run(); assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Build evidence retained:/);
    assert.doesNotMatch(first.out, /previous output|Previous output/);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.output, '.jaw-sidecar-build.json'), 'utf8'));
    const install = JSON.parse(fs.readFileSync(path.join(f.output, '.jaw-install-state.json'), 'utf8'));
    assert.equal(install.node, 'v24.17.0', 'fixture target version must not come from the host Node');
    assert.equal(receipt.format, 1); assert.equal(receipt.target, target.join('-'));
    assert.equal(receipt.nodeVersion, '24.17.0'); assert.equal(receipt.packageVersion, '2.17.38');
    assert.equal(receipt.generator, 'scripts/bundle-sidecar.sh'); assert.equal(receipt.state, 'completed');
    assert.match(receipt.invocation, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(receipt), /fixture|\/Users\/|\/tmp\//);
    assert.equal(fs.existsSync(f.lock), false); assert.equal(fs.existsSync(path.join(f.project, 'dist')), false);
    const second = await f.run(); assert.equal(second.code, 0, second.out);
    const builds = f.builds(); assert.equal(builds.length, 2);
    const backup = builds.find(b => fs.existsSync(path.join(b, 'previous-server')))!;
    assert.ok(second.out.includes(`Previous output retained: ${path.join(backup, 'previous-server')}`));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, 'previous-server/.jaw-sidecar-build.json'), 'utf8')), receipt);
    const next = JSON.parse(fs.readFileSync(path.join(f.output, '.jaw-sidecar-build.json'), 'utf8'));
    assert.notEqual(next.invocation, receipt.invocation);
    const commands = f.commands();
    const downloads = commands.filter(c => c.command === 'curl').map(c => c.args.at(-1));
    assert.equal(new Set(downloads).size, 2); assert.equal(fs.readdirSync(path.join(f.root, 'tmp')).length, 0);
    assert.equal(commands.filter(c => c.command === 'smoke').length, 2);
    for (const c of commands.filter(c => c.command === 'npm')) assert.ok(c.cwd.startsWith(f.parent + '/.server-build.'));
    assert.ok(commands.some(c => c.command === 'npm' && c.args.join(' ') === 'ci --omit=dev --ignore-scripts'));
    assert.ok(commands.some(c => c.command === 'npm' && c.args.join(' ') === 'run build --ignore-scripts'));
    for (const b of builds) assert.equal(fs.existsSync(path.join(b, 'smoke-report.json')), true);
}));

test('declared target and fake native receipt version must agree before promotion', { skip: !supported }, async () => owned(async f => {
    f.mode('wrong-native-version'); const r = await f.run();
    assert.notEqual(r.code, 0, r.out); assert.match(r.out, /Output provenance mismatch/);
    assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.lock), true);
    const install = JSON.parse(fs.readFileSync(path.join(f.builds()[0]!, 'server/.jaw-install-state.json'), 'utf8'));
    assert.equal(install.node, 'v22.0.0');
    assert.doesNotMatch(r.out, /Sidecar ready/);
}));

test('actual compiled-asset checker rejects a missing literal mjs asset and admits the matching asset', { skip: !supported }, async () => {
    for (const mode of ['asset-missing', 'asset-present']) await owned(async f => {
        f.mode(mode); const r = await f.run();
        if (mode === 'asset-missing') {
            assert.notEqual(r.code, 0, r.out);
            assert.match(r.out, /missing: \.\/required-sidecar\.mjs \(imported from literal-asset\.js\)/);
            assert.equal(fs.existsSync(f.output), false);
            assert.equal(fs.existsSync(f.lock), true);
            const stage = path.join(f.builds()[0]!, 'server');
            assert.equal(fs.existsSync(path.join(stage, '.jaw-install-state.json')), false);
            assert.equal(fs.existsSync(path.join(stage, '.jaw-sidecar-build.json')), false);
            assert.equal(f.commands().some(c => c.command === 'native' || c.command === 'smoke'), false);
            assert.equal(f.commands().some(c => c.command === 'npm' && c.args.includes('build:frontend')), false);
        } else {
            assert.equal(r.code, 0, r.out);
            assert.match(r.out, /\[verify-dist-assets\] ok/);
            assert.equal(fs.readFileSync(path.join(f.output, 'dist/required-sidecar.mjs'), 'utf8'), 'export {};');
            assert.equal(fs.existsSync(path.join(f.output, '.jaw-sidecar-build.json')), true);
            assert.equal(f.commands().filter(c => c.command === 'smoke').length, 1);
        }
    });
});

test('failed promotion retains recoverable exact previous output and refuses automatic recovery', { skip: !supported }, async () => owned(async f => {
    assert.equal((await f.run()).code, 0);
    const previous = fs.readFileSync(path.join(f.output, '.jaw-sidecar-build.json'), 'utf8');
    f.mode('promotion-fail'); const r = await f.run(); assert.notEqual(r.code, 0, r.out);
    assert.equal(fs.existsSync(f.output), false); assert.equal(fs.existsSync(f.lock), true);
    const recovery = f.builds().find(b => fs.existsSync(path.join(b, 'previous-server')))!;
    assert.equal(fs.readFileSync(path.join(recovery, 'previous-server/.jaw-sidecar-build.json'), 'utf8'), previous);
    assert.equal(fs.existsSync(path.join(recovery, 'server/.jaw-sidecar-build.json')), true);
    assert.notEqual((await f.run()).code, 0); assert.doesNotMatch(r.out, /Sidecar ready/);
}));

test('changed generated output, source drift and late unknown output refuse replacement', { skip: !supported }, async () => {
    for (const mode of ['changed-output', 'source-change', 'late-output']) await owned(async f => {
        if (mode === 'changed-output') {
            assert.equal((await f.run()).code, 0);
            fs.writeFileSync(path.join(f.output, 'foreign'), 'untouched');
        } else f.mode(mode);
        const r = await f.run(); assert.notEqual(r.code, 0, r.out); assert.doesNotMatch(r.out, /Sidecar ready/);
        if (mode !== 'source-change') assert.equal(fs.readFileSync(path.join(f.output, 'foreign'), 'utf8'), 'untouched');
        if (mode === 'source-change') assert.equal(fs.existsSync(f.output), false);
    });
});

test('changed staging/dependency ownership and unknown cleanup contents are retained', { skip: !supported }, async () => {
    for (const mode of ['dependency-link', 'stage-swap', 'unknown-extraction']) await owned(async f => {
        f.mode(mode); const r = await f.run(); assert.notEqual(r.code, 0, r.out);
        assert.doesNotMatch(r.out, /Sidecar ready/); assert.equal(fs.existsSync(f.lock), true);
        if (mode === 'dependency-link') {
            assert.equal(fs.readFileSync(path.join(f.root, 'foreign-deps/react/sentinel'), 'utf8'), 'do not prune');
            assert.equal(fs.existsSync(f.output), false);
        }
        if (mode === 'stage-swap') {
            const stage = path.join(f.builds()[0]!, 'server');
            assert.equal(fs.readFileSync(path.join(stage, 'foreign'), 'utf8'), 'untouched');
            assert.equal(fs.existsSync(path.join(stage, '.jaw-install-state.json')), false);
            assert.equal(fs.existsSync(f.output), false);
        }
        if (mode === 'unknown-extraction') {
            const extraction = fs.readdirSync(path.join(f.root, 'tmp'))[0]!;
            assert.equal(fs.readFileSync(path.join(f.root, 'tmp', extraction, 'foreign'), 'utf8'), 'untouched');
            assert.equal(fs.existsSync(path.join(f.lock, 'owner.json')), true);
            // Publication already succeeded; cleanup uncertainty is still a failure,
            // and must not destroy the valid output or unlock the transaction.
            assert.equal(fs.existsSync(path.join(f.output, '.jaw-sidecar-build.json')), true);
        }
    });
});
