import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { hasDashboardCommand, spawnJawDashboard, findJawBinary } from '../../electron/src/main/lib/jaw-spawn.ts';
import { RingBuffer } from '../../electron/src/main/lib/ring-buffer.ts';
import { readIsolatedQaPolicy, isolatedQaEnvironment } from '../../src/shared/isolated-qa.ts';

function writeExecutable(dir: string, name: string, content: string): string {
    const file = join(dir, name);
    writeFileSync(file, content, 'utf8');
    chmodSync(file, 0o755);
    return file;
}

test('electron jaw spawn rejects stale jaw binaries without dashboard command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-electron-spawn-'));
    try {
        const staleJaw = writeExecutable(dir, 'jaw-stale', `#!/bin/sh
if [ "$1" = "dashboard" ]; then
  echo "Unknown command: dashboard" >&2
  exit 1
fi
exit 0
`);

        assert.equal(hasDashboardCommand(staleJaw), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('electron jaw spawn accepts jaw binaries with dashboard subcommands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-electron-spawn-'));
    try {
        const currentJaw = writeExecutable(dir, 'jaw-current', `#!/bin/sh
if [ "$1" = "dashboard" ]; then
  echo "Unknown dashboard command: $2" >&2
  echo "Usage: jaw dashboard serve [options]" >&2
  exit 1
fi
exit 0
`);

        assert.equal(hasDashboardCommand(currentJaw), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('electron jaw spawn suppresses external browser open for owned manager', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-electron-spawn-'));
    try {
        const currentJaw = writeExecutable(dir, 'jaw-current', `#!/bin/sh
printf '%s\\n' "$@"
exit 0
`);
        const ringBuffer = new RingBuffer();
        const child = spawnJawDashboard(currentJaw, { port: 24577, ringBuffer });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });

        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
        assert.deepEqual(ringBuffer.read().trim().split(/\r?\n/), [
            'dashboard',
            'serve',
            '--port',
            '24577',
            '--no-open',
        ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('QA direct launch rejects conflicting ports, arbitrary binaries and escaped packaged artifacts before execution', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jaw-electron-qa-spawn-')));
    const priorResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    try {
        const env: NodeJS.ProcessEnv = { CLI_JAW_ISOLATED_QA_ROOT: root, PATH: '/usr/bin:/bin',
            DASHBOARD_PORT: '32001', DASHBOARD_SCAN_FROM: '32002', DASHBOARD_SCAN_COUNT: '1', DASHBOARD_PREVIEW_FROM: '32003' };
        for (const [key, suffix] of Object.entries({ HOME: 'home', TMPDIR: 'tmp', CLI_JAW_HOME: 'manager',
            CLI_JAW_DASHBOARD_HOME: 'dashboard', XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache',
            XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state', CODEX_HOME: 'providers/codex',
            CLAUDE_CONFIG_DIR: 'providers/claude', PI_CODING_AGENT_DIR: 'providers/pi' })) {
            env[key] = join(root, suffix); mkdirSync(env[key]!, { recursive: true });
        }
        for (const suffix of ['worker', 'electron/userData', 'electron/sessionData', 'electron/logs', 'electron/crashDumps',
            'resources/server/bin', 'resources/server/dist/bin']) mkdirSync(join(root, suffix), { recursive: true });
        const policy = readIsolatedQaPolicy(env, 'electron')!;
        Object.defineProperty(process, 'resourcesPath', { configurable: true, value: join(root, 'resources') });
        const server = join(root, 'resources/server');
        const node = writeExecutable(server, process.platform === 'win32' ? 'node.exe' : 'node', 'not an executable fixture');
        const shim = writeExecutable(join(server, 'bin'), process.platform === 'win32' ? 'jaw.cmd' : 'jaw', 'not an executable fixture');
        writeFileSync(join(server, 'dist/bin/cli-jaw.js'), 'not executable');
        const ringBuffer = new RingBuffer();
        for (const port of [0, 32002, NaN, 65536]) {
            assert.throws(() => spawnJawDashboard(shim, { port, ringBuffer, qaPolicy: policy, env }), /must match manager port/);
        }
        assert.throws(() => spawnJawDashboard('/forbidden/personal/jaw', { port: 32001, ringBuffer, qaPolicy: policy, env }), /packaged shim required/);
        assert.throws(() => hasDashboardCommand('/forbidden/personal/jaw', policy), /packaged shim required/);
        assert.throws(() => spawnJawDashboard(shim, { port: 32001, ringBuffer, qaPolicy: policy,
            env: { ...env, PATH: 'relative/path' } }), /PATH/);
        rmSync(node);
        assert.throws(() => spawnJawDashboard(shim, { port: 32001, ringBuffer, qaPolicy: policy, env }), /missing or noncanonical artifact/);
        const outside = writeExecutable(root, 'outside-node', 'not executable');
        symlinkSync(outside, node);
        assert.throws(() => spawnJawDashboard(shim, { port: 32001, ringBuffer, qaPolicy: policy, env }), /missing or noncanonical artifact/);
    } finally {
        if (priorResources) Object.defineProperty(process, 'resourcesPath', priorResources);
        else Reflect.deleteProperty(process, 'resourcesPath');
        rmSync(root, { recursive: true, force: true });
    }
});

test('present-empty opt-in fails closed at each public spawn entry before fallback', async () => {
    const previous = process.env.CLI_JAW_ISOLATED_QA_ROOT;
    process.env.CLI_JAW_ISOLATED_QA_ROOT = '';
    try {
        await assert.rejects(findJawBinary(), /CLI_JAW_ISOLATED_QA_ROOT/);
        assert.throws(() => hasDashboardCommand('/forbidden/personal/jaw'), /CLI_JAW_ISOLATED_QA_ROOT/);
        assert.throws(() => spawnJawDashboard('/forbidden/personal/jaw', { port: 24577, ringBuffer: new RingBuffer() }), /CLI_JAW_ISOLATED_QA_ROOT/);
    } finally {
        if (previous === undefined) delete process.env.CLI_JAW_ISOLATED_QA_ROOT;
        else process.env.CLI_JAW_ISOLATED_QA_ROOT = previous;
    }
});

test('actual dashboard Node CLI forwards TERM once and does not exit until its manager child exits', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jaw-electron-qa-chain-')));
    try {
        const env: NodeJS.ProcessEnv = { CLI_JAW_ISOLATED_QA_ROOT: root, PATH: '/usr/bin:/bin',
            DASHBOARD_PORT: '32001', DASHBOARD_SCAN_FROM: '32002', DASHBOARD_SCAN_COUNT: '1', DASHBOARD_PREVIEW_FROM: '32003' };
        for (const [key, suffix] of Object.entries({ HOME: 'home', TMPDIR: 'tmp', CLI_JAW_HOME: 'manager',
            CLI_JAW_DASHBOARD_HOME: 'dashboard', XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache',
            XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state', CODEX_HOME: 'providers/codex',
            CLAUDE_CONFIG_DIR: 'providers/claude', PI_CODING_AGENT_DIR: 'providers/pi' })) {
            env[key] = join(root, suffix); mkdirSync(env[key]!, { recursive: true });
        }
        for (const suffix of ['worker', 'electron/userData', 'electron/sessionData', 'electron/logs', 'electron/crashDumps',
            'package/dist/src/manager', 'package/bin/commands']) mkdirSync(join(root, suffix), { recursive: true });
        const server = join(root, 'package/dist/src/manager/server.js');
        writeFileSync(server, 'never executed fixture'); writeFileSync(join(root, 'package/package.json'), '{}');
        const source = resolve('bin/commands/dashboard.ts');
        const output = ts.transpileModule(readFileSync(source, 'utf8'), {
            fileName: source, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
            transformers: { before: [context => file => {
                const visit: ts.Visitor = node => {
                    if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression) && node.name.text === 'url') {
                        return context.factory.createStringLiteral(pathToFileURL(join(root, 'package/bin/commands/dashboard.js')).href);
                    }
                    return ts.visitEachChild(node, visit, context);
                };
                return ts.visitNode(file, visit) as ts.SourceFile;
            }] },
        }).outputText;
        const require = createRequire(import.meta.url);
        for (const completion of [{ code: 0, signal: null }, { code: null, signal: 'SIGTERM' }, { code: 75, signal: null }]) {
            const signals: string[] = []; const exits: number[] = []; const spawns: unknown[][] = [];
            const exited = new Error('fixture process exited');
            const child = Object.assign(new EventEmitter(), { kill: (signal: string) => { signals.push(signal); return true; } });
            const proc = Object.assign(new EventEmitter(), { env, execPath: '/fixture/node',
                argv: ['/fixture/node', '/fixture/cli-jaw.js', 'dashboard', 'serve', '--port', '32001', '--from', '32002', '--count', '1', '--no-open'],
                exit: (code: number): never => { exits.push(code); throw exited; } });
            await runInNewContext(`(async () => { ${output}\n })()`, { exports: {}, process: proc,
                console: { log() {}, error() {} }, require: (specifier: string) => {
                    if (specifier === 'node:child_process') return { spawn: (...args: unknown[]) => { spawns.push(args); return child; } };
                    if (specifier.startsWith('node:')) return require(specifier);
                    if (specifier.endsWith('/isolated-qa.js')) return { readIsolatedQaPolicy, isolatedQaEnvironment };
                    if (specifier.endsWith('/constants.js')) return { DASHBOARD_DEFAULT_PORT: 24576, MANAGED_INSTANCE_PORT_FROM: 3457, MANAGED_INSTANCE_PORT_COUNT: 50 };
                    if (specifier.endsWith('/runtime-path.js')) return { resolveBundledNodePath: () => '/fixture/packaged-node' };
                    if (specifier.endsWith('/help.js')) return { shouldShowHelp: () => false };
                    if (specifier.endsWith('/browser-open-default.js')) return { shouldOpenBrowserByDefault: () => false };
                    if (specifier.endsWith('/_http-client.js')) return {};
                    throw new Error(`unmocked dependency: ${specifier}`);
                },
            });
            assert.equal(spawns.length, 1);
            assert.equal(spawns[0][0], '/fixture/packaged-node');
            assert.deepEqual(Array.from(spawns[0][1] as string[]), [server]);
            proc.emit('SIGTERM'); proc.emit('SIGTERM'); proc.emit('SIGINT');
            assert.deepEqual(signals, ['SIGTERM']); assert.deepEqual(exits, []);
            assert.throws(() => child.emit('exit', completion.code, completion.signal), error => error === exited);
            assert.deepEqual(exits, [completion.signal ? 143 : completion.code]);
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});
