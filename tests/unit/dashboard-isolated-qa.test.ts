import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import ts from 'typescript';
import { readIsolatedQaPolicy, isolatedQaEnvironment } from '../../src/shared/isolated-qa.js';
import type { DashboardLifecycleAction, DashboardLifecycleResult, DashboardScanResult } from '../../src/manager/types.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

function fixture(t: TestContext) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jaw-qa-dashboard-')));
    const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8',
        CLI_JAW_ISOLATED_QA_ROOT: root, DASHBOARD_PORT: '25482', DASHBOARD_SCAN_FROM: '35482',
        DASHBOARD_SCAN_COUNT: '1', DASHBOARD_PREVIEW_FROM: '45482' };
    const roots = { HOME: 'home', TMPDIR: 'tmp', CLI_JAW_HOME: 'manager', CLI_JAW_DASHBOARD_HOME: 'dashboard',
        XDG_CONFIG_HOME: 'xdg/config', XDG_CACHE_HOME: 'xdg/cache', XDG_DATA_HOME: 'xdg/data', XDG_STATE_HOME: 'xdg/state',
        CODEX_HOME: 'providers/codex', CLAUDE_CONFIG_DIR: 'providers/claude', PI_CODING_AGENT_DIR: 'providers/pi' };
    for (const suffix of [...Object.values(roots), 'worker', 'electron/userData', 'electron/sessionData', 'electron/logs', 'electron/crashDumps']) {
        mkdirSync(join(root, suffix), { recursive: true });
    }
    for (const [key, suffix] of Object.entries(roots)) env[key] = join(root, suffix);
    const policy = readIsolatedQaPolicy(env, 'manager')!;
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, env: isolatedQaEnvironment(policy, env) };
}

// Compile the actual entrypoint, changing import locations only. No copied
// parser/route implementation and no source-text assertions are used as oracles.
function compile(source: string, target: string, redirect: (specifier: string) => string | undefined = () => undefined): void {
    const rebase = (specifier: string): string => redirect(specifier) ?? (specifier.startsWith('.')
        ? pathToFileURL(resolve(dirname(source), specifier.replace(/\.js$/, '.ts'))).href
        : specifier.startsWith('node:') ? specifier : pathToFileURL(require.resolve(specifier)).href);
    const output = ts.transpileModule(readFileSync(source, 'utf8'), {
        fileName: source,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        transformers: { before: [context => node => {
            const visit: ts.Visitor = current => {
                if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) {
                    return context.factory.updateImportDeclaration(current, current.modifiers, current.importClause,
                        context.factory.createStringLiteral(rebase(current.moduleSpecifier.text)), current.attributes);
                }
                if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword
                    && current.arguments[0] && ts.isStringLiteral(current.arguments[0])) {
                    return context.factory.updateCallExpression(current, current.expression, current.typeArguments,
                        [context.factory.createStringLiteral(rebase(current.arguments[0].text))]);
                }
                return ts.visitEachChild(current, visit, context);
            };
            return ts.visitNode(node, visit) as ts.SourceFile;
        }] },
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output.outputText);
}

function cliFixture(t: TestContext) {
    const f = fixture(t);
    const pkg = join(f.root, 'package');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0-qa' }));
    const cli = join(pkg, 'bin/cli-jaw.js');
    const dashboard = join(pkg, 'bin/commands/dashboard.js');
    compile(join(repo, 'bin/cli-jaw.ts'), cli, spec => spec === './commands/dashboard.js' ? pathToFileURL(dashboard).href : undefined);
    compile(join(repo, 'bin/commands/dashboard.ts'), dashboard);
    const witness = join(pkg, 'dist/src/manager/server.js');
    mkdirSync(dirname(witness), { recursive: true });
    writeFileSync(witness, "console.log('GRANDCHILD '+JSON.stringify({argv:process.argv,env:process.env,pid:process.pid,ppid:process.ppid}));\n");
    const run = (args: string[], env = f.env) => execFileSync(process.execPath,
        ['--import', pathToFileURL(require.resolve('tsx')).href, cli, ...args], {
            cwd: pkg, env, encoding: 'utf8', stdio: 'pipe', timeout: 10_000, maxBuffer: 1024 * 1024,
        });
    return { ...f, cli, witness, run };
}

test('actual CLI dashboard -> grandchild inherits exact QA roles/ports and a fresh allowlist', t => {
    const f = cliFixture(t);
    for (const flags of [[], ['--port', '25482', '--from', '35482', '--count', '1']]) {
        const out = f.run(['--home', join(f.root, 'manager'), 'dashboard', 'serve', '--no-open', ...flags], {
            ...f.env, PORT: '9999', CLI_JAW_BIN: '/forbidden/jaw', NODE_OPTIONS: '',
            SLACK_BOT_TOKEN: 'qa-sentinel', HTTPS_PROXY: 'http://forbidden.invalid',
            CLI_JAW_ELECTRON_RENDERER_TOKEN: 'a'.repeat(64),
        });
        const receipt = JSON.parse(out.split('\n').find(line => line.startsWith('GRANDCHILD '))!.slice(11));
        assert.deepEqual(receipt.argv, [process.execPath, f.witness]);
        assert.equal(receipt.env.CLI_JAW_HOME, join(f.root, 'manager'));
        assert.equal(receipt.env.HOME, join(f.root, 'home'));
        assert.equal(receipt.env.CLI_JAW_DASHBOARD_HOME, join(f.root, 'dashboard'));
        assert.equal(receipt.env.CODEX_HOME, join(f.root, 'providers/codex'));
        assert.equal(receipt.env.DASHBOARD_PORT, '25482');
        assert.equal(receipt.env.DASHBOARD_SCAN_FROM, '35482');
        assert.equal(receipt.env.DASHBOARD_SCAN_COUNT, '1');
        assert.equal(receipt.env.DASHBOARD_PREVIEW_FROM, '45482');
        assert.equal(receipt.env.USERPROFILE, join(f.root, 'home'));
        assert.equal(receipt.env.APPDATA, join(f.root, 'xdg/data'));
        assert.equal(receipt.env.LOCALAPPDATA, join(f.root, 'xdg/cache'));
        assert.equal(receipt.env.CLI_JAW_ELECTRON_RENDERER_TOKEN, 'a'.repeat(64));
        assert.equal(receipt.env.JAW_DASHBOARD_OPEN, '0');
        for (const key of ['PORT', 'CLI_JAW_BIN', 'NODE_OPTIONS', 'SLACK_BOT_TOKEN', 'HTTPS_PROXY']) assert.equal(receipt.env[key], undefined, key);
        assert.ok(receipt.pid > 0 && receipt.ppid > 0 && receipt.pid !== receipt.ppid);
    }
});

test('actual CLI rejects malformed/conflicting raw flags and env before grandchild spawn', t => {
    const f = cliFixture(t);
    const rejects = (args: string[], env = f.env) => {
        assert.throws(() => f.run(args, env), (error: unknown) => {
            const result = error as { status: number; stdout: string; stderr: string };
            assert.notEqual(result.status, 0);
            assert.doesNotMatch(String(result.stdout), /GRANDCHILD/);
            assert.match(String(result.stderr), /isolated.QA|isolated_qa|argument/i);
            return true;
        });
    };
    for (const flags of [['--port', '0'], ['--from', '0'], ['--count', '0'], ['--count', '2'], ['--port', 'oops'],
        ['--from='], ['--count=1e0'], ['--count=01'], ['--port=25483'], ['--port=0', '--port=25482'], ['--count'], ['--from', ' 35482']]) {
        rejects(['dashboard', 'serve', ...flags]);
    }
    for (const [key, value] of [['CLI_JAW_ISOLATED_QA_ROOT', ''], ['DASHBOARD_PORT', '0'], ['DASHBOARD_SCAN_COUNT', '0'],
        ['DASHBOARD_SCAN_FROM', 'oops'], ['DASHBOARD_PREVIEW_FROM', '25482']]) {
        rejects(['dashboard', 'serve'], { ...f.env, [key!]: value });
    }
    rejects(['--home', join(f.root, 'worker'), 'dashboard', 'serve']);
});

test('actual CLI normal dashboard defaults and explicit overrides remain unchanged', t => {
    const f = cliFixture(t);
    const env = { ...f.env };
    delete env.CLI_JAW_ISOLATED_QA_ROOT;
    delete env.DASHBOARD_PORT;
    const receipt = (flags: string[]) => JSON.parse(f.run(['dashboard', 'serve', '--no-open', ...flags], env)
        .split('\n').find(line => line.startsWith('GRANDCHILD '))!.slice(11));
    const normal = receipt([]);
    assert.equal(normal.env.DASHBOARD_PORT, '24576');
    assert.equal(normal.env.DASHBOARD_SCAN_FROM, '3457');
    assert.equal(normal.env.DASHBOARD_SCAN_COUNT, '50');
    const explicit = receipt(['--port', '25483', '--from', '35483', '--count', '2']);
    assert.equal(explicit.env.DASHBOARD_PORT, '25483');
    assert.equal(explicit.env.DASHBOARD_SCAN_FROM, '35483');
    assert.equal(explicit.env.DASHBOARD_SCAN_COUNT, '2');
});

async function managerFixture(t: TestContext, options: { normal?: boolean; corrupt?: unknown; invalidEnv?: boolean; legacy?: boolean; workerPort?: number } = {}) {
    const f = fixture(t);
    if (options.workerPort !== undefined) f.env.DASHBOARD_SCAN_FROM = String(options.workerPort);
    if (options.normal) delete f.env.CLI_JAW_ISOLATED_QA_ROOT;
    if (options.invalidEnv) f.env.DASHBOARD_PORT = '0';
    const registry = join(f.root, 'dashboard/manager-instances.json');
    if (options.corrupt !== undefined) writeFileSync(options.legacy
        ? join(f.root, 'manager/manager-instances.json') : registry, JSON.stringify(options.corrupt));
    const savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, f.env);
    const count: Record<string, number> = {};
    const hit = (key: string) => { count[key] = (count[key] ?? 0) + 1; };
    const noop = () => undefined;
    const route = () => express.Router();
    const seen: string[] = [];
    let direct: (input: { action: string; port: number }) => Promise<{ ok: boolean; data: DashboardLifecycleResult }>;
    let server: http.Server | undefined;
    let listen: http.Server['listen'] | undefined;
    const listeners = new Map(['SIGINT', 'SIGTERM', 'SIGUSR2'].map(signal => [signal, process.listeners(signal)]));
    const intervals: ReturnType<typeof setInterval>[] = [];
    const originalInterval = globalThis.setInterval;
    // Capture only the entrypoint's scheduling registrations; no job activation.
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const timer = originalInterval(...args); timer.unref(); intervals.push(timer); return timer;
    }) as typeof setInterval;
    const modules = new Map<string, Record<string, unknown>>();
    const stub = (path: string, values: Record<string, unknown>) => modules.set(path, values);
    stub('node:http', { default: { createServer(app: express.Express) {
        server = http.createServer(app); listen = server.listen;
        server.listen = (() => { hit('listen'); return server; }) as http.Server['listen'];
        return server;
    } } });
    stub('../core/config.js', { SETTINGS_PATH: join(f.root, 'manager/settings.json'), ensureDirs: () => hit('ensureDirs'), loadSettings: () => hit('loadSettings') });
    stub('./lifecycle.js', { DashboardLifecycleManager: class {
        constructor(readonly options: unknown) { hit('lifecycleConstructor'); }
        async hydrate() { hit('hydrate'); return { adopted: 0, pruned: 0 }; }
        decorateScanResult(result: DashboardScanResult) { return result; }
        decorateInstance(row: unknown) { return row; }
        isDashboardPort(port: number) { return port >= 24576 && port < 24590; }
        async start(port: number) { return this.action('start', port); }
        async stop(port: number) { return this.action('stop', port); }
        async restart(port: number) { return this.action('restart', port); }
        async perm(port: number) { return this.action('perm', port); }
        async unperm(port: number) { return this.action('unperm', port); }
        action(action: DashboardLifecycleAction, port: number) { hit(action); return { ok: true, action, port, status: 'started', message: 'fixture' }; }
    } });
    stub('./platform-service.js', { detectAllServiceStates: async () => { hit('serviceAll'); return new Map(); },
        detectServiceState: async () => { hit('serviceSingle'); return null; }, isServiceSupported: () => { hit('serviceSupported'); return true; } });
    stub('./preview-origin-proxy.js', { createPreviewOriginProxyController: () => {
        hit('previewConstructor'); return { validate: noop, snapshot: () => ({}), close: async () => undefined,
            reconcileOnlineTargets: async () => hit('preview'), ensureTarget: async () => hit('preview') };
    } });
    stub('./internal-fetch.js', { internalFetch: async (url: string) => {
        seen.push(url);
        if (!options.normal && new URL(url).port !== f.env.DASHBOARD_SCAN_FROM) throw new Error('FORBIDDEN FETCH SENTINEL');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } });
    stub('./shutdown.js', { createDashboardShutdown: () => async () => undefined });
    stub('../agent/spawn.js', { killAllAgents: () => hit('killAllAgents') });
    stub('./proxy.js', { installDashboardProxy: () => hit('proxyConstructor') });
    stub('./logs.js', { fetchInstanceLogs: noop });
    stub('../core/bus.js', { addBroadcastListener: noop });
    stub('../core/browser-open.js', { openUrlInBrowser: () => hit('browser') });
    stub('../routes/events.js', { exceedsBackpressureLimit: () => false, SSE_MAX_BUFFER_BYTES: 1024, registerEventsRoutes: noop });
    stub('./worker-messages.js', { fetchWorkerAssistantTextById: noop });
    stub('./worker-events.js', { startWorkerEventBridge: noop, stopWorkerEventBridge: noop, getCachedLatestMessage: noop });
    stub('./notes/watcher.js', { createNotesWatcher: () => { hit('watcher'); return { close: noop }; } });
    stub('./notes/ws.js', { NoteWsServer: class { close() {} issueToken() { return 'fixture'; } } });
    for (const [file, name] of [['notes/store', 'NotesStore'], ['schedule/store', 'ScheduleStore'], ['reminders/store', 'RemindersStore']]) {
        stub(`./${file}.js`, { [name!]: class { constructor() { hit('store'); } rootPath() { return join(f.root, 'dashboard'); } } });
    }
    for (const [file, name] of [['notes/routes', 'createDashboardNotesRouter'], ['routes/desktop-status', 'createDesktopStatusRouter'],
        ['routes/electron-metrics', 'createElectronMetricsRouter'], ['board/routes', 'createDashboardBoardRouter'],
        ['schedule/routes', 'createDashboardScheduleRouter'], ['reminders/routes', 'createDashboardRemindersRouter'],
        ['connector/routes', 'createDashboardConnectorRouter'], ['routes/dashboard-memory', 'createDashboardMemoryRouter'],
        ['notes/wiki-routes', 'createDashboardWikiRouter'], ['routes/dashboard-git', 'createDashboardGitRouter'],
        ['routes/telegram-hub', 'createDashboardTelegramHubRouter'], ['routes/dashboard-design', 'createDashboardDesignRouter']]) {
        stub(`./${file}.js`, { [name!]: route });
    }
    stub('./schedule/runner.js', { startScheduleRunner: () => hit('schedule') });
    stub('./reminders/scheduler.js', { startRemindersScheduler: noop });
    stub('./telegram-hub/hub-bot.js', { startHubBot: noop });
    stub('./routes/runtime-monitor.js', { registerManagerRuntimeMonitorRoutes: noop });
    stub('./routes/embedded-browser.js', { registerEmbeddedBrowserRoutes: noop });
    stub('../routes/code.js', { registerCodeRoutes: noop });
    stub('./memory/embedding/index.js', { VecStore: class {}, getVecDbPath: noop, createProvider: noop, syncAllInstances: noop });
    stub('../routes/jaw-ceo.js', { createJawCeoRouter: (deps: { runLifecycleAction: typeof direct }) => { direct = deps.runLifecycleAction; return route(); } });

    const mockRoot = join(f.root, 'modules'); mkdirSync(mockRoot);
    const globals = globalThis as unknown as Record<string, unknown>;
    const globalKey = `qa_${Date.now()}_${Math.random()}`;
    globals[globalKey] = [...modules.values()];
    const imports = new Map<string, string>();
    let index = 0;
    for (const [specifier, exports] of modules) {
        const file = join(mockRoot, `${index}.mjs`);
        writeFileSync(file, Object.keys(exports).map(name => name === 'default'
            ? `export default globalThis[${JSON.stringify(globalKey)}][${index}].default;`
            : `export const ${name} = globalThis[${JSON.stringify(globalKey)}][${index}][${JSON.stringify(name)}];`).join('\n'));
        imports.set(specifier, pathToFileURL(file).href); index++;
    }
    // Keep all scanner implementation bytes; redirect only its HTTP transport.
    const scanner = join(f.root, 'scan.mjs');
    compile(join(repo, 'src/manager/scan.ts'), scanner, spec => spec === './internal-fetch.js' ? imports.get(spec) : undefined);
    imports.set('./scan.js', pathToFileURL(scanner).href);
    const entry = join(f.root, 'server.mjs');
    compile(join(repo, 'src/manager/server.ts'), entry, spec => imports.get(spec));
    let error: unknown;
    try { await import(pathToFileURL(entry).href); } catch (caught) { error = caught; }
    globalThis.setInterval = originalInterval;
    t.after(async () => {
        delete globals[globalKey];
        for (const timer of intervals) clearInterval(timer);
        for (const [signal, original] of listeners) for (const listener of process.listeners(signal)) {
            if (!original.includes(listener)) process.removeListener(signal, listener);
        }
        if (server?.listening) await new Promise<void>((done, fail) => server!.close(err => err ? fail(err) : done()));
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, savedEnv);
    });
    let base = '';
    if (server && listen) {
        await new Promise<void>(done => listen!.call(server!, 0, '127.0.0.1', done));
        const address = server.address(); assert.ok(address && typeof address === 'object');
        base = `http://127.0.0.1:${address.port}`;
    }
    const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
        const response = await fetch(base + path, { method, ...(body === undefined ? {} : {
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }), signal: AbortSignal.timeout(2000) });
        return { status: response.status, body: await response.json() };
    };
    return { ...f, registry, count, seen, error, request, direct: (action: string, port = 35482) => direct({ action, port }) };
}

test('Manager rejects malformed QA env and raw persisted ranges before body side effects', async t => {
    for (const options of [{ invalidEnv: true }, ...[0, 2, '1', null].map(count => ({ corrupt: { scan: { from: 35482, count } } })),
        ...[0, 35483, '35482'].map(from => ({ corrupt: { scan: { from, count: 1 } } })),
        { corrupt: { scan: null } }, { corrupt: { scan: { from: 35482, count: 0 } }, legacy: true }]) {
        await t.test(JSON.stringify(options), async child => {
            const f = await managerFixture(child, options);
            assert.ok(f.error);
            assert.deepEqual(f.count, {});
            assert.equal(f.seen.length, 0);
            if ('legacy' in options) assert.equal(existsSync(f.registry), false, 'invalid legacy source cannot migrate');
        });
    }
});

test('Manager QA custom/single/stored ranges fail before fetch, cache, service metadata or preview', async t => {
    const f = await managerFixture(t);
    assert.equal(f.error, undefined);
    const valid = await f.request('/api/dashboard/instances?from=35482&count=1');
    assert.equal(valid.status, 200);
    assert.equal(valid.body.instances.length, 1);
    assert.deepEqual(valid.body.peerDashboards, []);
    assert.equal(f.seen.length, 3);
    assert.equal(f.count.hydrate, undefined);
    assert.equal(f.count.serviceAll, undefined);
    const beforeFetch = f.seen.length;
    const beforePreview = f.count.preview;
    for (const query of ['from=35483', 'count=2', 'count=0', 'from=', 'count=1e0', 'count=01', 'count=1&count=2']) {
        assert.equal((await f.request(`/api/dashboard/instances?${query}`)).status, 400);
    }
    for (const port of [24576, 25482, 35483, 45482]) {
        assert.equal((await f.request(`/api/dashboard/instances/${port}`)).status, 400);
    }
    assert.equal(f.seen.length, beforeFetch);
    assert.equal(f.count.preview, beforePreview);
    for (const scan of [{ from: 35483 }, { count: 0 }, { count: '1' }, { count: null }]) {
        const result = await f.request('/api/dashboard/registry', { scan }, 'PATCH');
        assert.ok(result.status >= 400);
        assert.equal(existsSync(f.registry), false, 'rejected patch must not reach registry persistence');
    }
    writeFileSync(f.registry, JSON.stringify({ scan: { from: 35482, count: 0 } }));
    for (const path of ['/api/dashboard/instances', '/api/dashboard/instances?fresh=1', '/api/dashboard/instances/35482']) {
        assert.ok((await f.request(path)).status >= 400, 'invalid stored range cannot reuse a warm cache');
    }
    assert.equal(f.seen.length, beforeFetch);
    assert.equal(f.count.preview, beforePreview);
});

test('Manager QA lifecycle rejects HTTP and direct callbacks before all lifecycle/service calls', async t => {
    const f = await managerFixture(t);
    assert.equal(f.error, undefined);
    for (const action of ['start', 'stop', 'restart', 'perm', 'unperm']) {
        const httpResult = await f.request(`/api/dashboard/lifecycle/${action}`, { port: 35482 });
        assert.equal(httpResult.status, 400);
        assert.equal(httpResult.body.status, 'rejected');
        assert.equal((await f.direct(action)).data.status, 'rejected');
        assert.equal(f.count[action], undefined);
    }
    assert.equal(f.count.serviceSingle, undefined);
    assert.equal(f.count.serviceSupported, undefined);
    assert.equal(f.count.hydrate, undefined);
});

test('Manager treats admitted W as a worker even inside the normal peer-dashboard port band', async t => {
    const f = await managerFixture(t, { workerPort: 24576 });
    assert.equal(f.error, undefined);
    const result = await f.request('/api/dashboard/instances/24576');
    assert.equal(result.status, 200);
    assert.equal(result.body.instance.port, 24576);
    assert.equal(result.body.instance.status, 'online');
    assert.equal(f.seen.length, 3);
    assert.ok(f.seen.every(url => new URL(url).port === '24576' && !url.includes('/api/dashboard/')));
});

test('Manager normal HTTP/direct lifecycle callbacks and service metadata remain active', async t => {
    const f = await managerFixture(t, { normal: true });
    assert.equal(f.error, undefined);
    for (const action of ['start', 'stop', 'restart', 'perm', 'unperm']) {
        assert.equal((await f.request(`/api/dashboard/lifecycle/${action}`, { port: 35482 })).status, 200);
        assert.equal((await f.direct(action)).ok, true);
        assert.equal(f.count[action], 2);
    }
    assert.equal(f.count.hydrate, 1);
    assert.equal(f.count.serviceSingle, 6);
    assert.equal(f.count.serviceSupported, 6);
});
