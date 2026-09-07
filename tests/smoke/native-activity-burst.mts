import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OwnedProcess } from '../../src/agent/spawn/process-kill.js';
import type { BurstBinding, BurstCycle, BurstMetrics } from '../fixtures/native-activity-burst-server.mts';
import type { BurstBrowserSnapshot } from '../fixtures/web-activity-burst.js';
import type { Browser, BrowserContext, CDPSession, Page, Request as BrowserRequest } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROTOCOL = 'wp29-burst-v2';
const OUTPUT_BYTES = 2_097_152;
const HEADER = 'x-wp29-probe';
const COOKIE = 'wp29_probe';
const LIMIT_MS = 15 * 60_000;
const CYCLE_MS = 30_000;
const LOG_BYTES = 4 * 1024 * 1024;

export interface MemorySeriesInput {
    initial: number[]; measured: number[]; final: number[]; pageBytes: number; identityStable: boolean;
}
export interface MemoryVerdict {
    verdict: 'PLATEAU_OBSERVED' | 'GROWTH_OBSERVED' | 'INCONCLUSIVE';
    reason: string; noise: number | null; windows: number[]; lateSlope: number | null;
    totalChange: number | null; lateChange: number | null; nineSlope: number | null;
}
export function median(values: readonly number[]): number {
    assert.ok(values.length > 0 && values.every(Number.isFinite));
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function classifyMemory(input: MemorySeriesInput): MemoryVerdict {
    const unavailable = (reason: string): MemoryVerdict => ({ verdict: 'INCONCLUSIVE', reason,
        noise: null, windows: [], lateSlope: null, totalChange: null, lateChange: null, nineSlope: null });
    if (!input.identityStable) return unavailable('process identity changed or unavailable');
    if (input.initial.length !== 5 || input.final.length !== 5 || input.measured.length !== 20
        || !Number.isSafeInteger(input.pageBytes) || input.pageBytes <= 0
        || [...input.initial, ...input.final, ...input.measured].some(value => !Number.isSafeInteger(value) || value <= 0))
        return unavailable('missing or invalid same-seam samples');
    const range = (values: number[]) => Math.max(...values) - Math.min(...values);
    const mad = (values: number[]) => { const center = median(values); return median(values.map(value => Math.abs(value - center))); };
    const noise = Math.max(input.pageBytes, range(input.initial), range(input.final), 3 * mad(input.initial), 3 * mad(input.final));
    const windows = [0, 5, 10, 15].map(start => median(input.measured.slice(start, start + 5)));
    const late = input.measured.slice(10), slopes: number[] = [];
    for (let left = 0; left < late.length; left++) for (let right = left + 1; right < late.length; right++)
        slopes.push((late[right]! - late[left]!) / (right - left));
    const lateSlope = median(slopes), totalChange = windows[3]! - windows[0]!, lateChange = windows[3]! - windows[2]!;
    const nineSlope = 9 * lateSlope;
    const common = { noise, windows, lateSlope, totalChange, lateChange, nineSlope };
    if (noise >= OUTPUT_BYTES) return { ...common, verdict: 'INCONCLUSIVE', reason: 'noise is at least one bulk submission' };
    const increases = [1, 2, 3].map(index => windows[index]! - windows[index - 1]!);
    if (Math.abs(lateChange) <= noise && Math.abs(nineSlope) <= noise && !(increases[1]! > noise && increases[2]! > noise))
        return { ...common, verdict: 'PLATEAU_OBSERVED', reason: 'no sustained late increase above measured noise over20 fixed cycles' };
    if (increases.every(value => value > noise) && nineSlope > noise)
        return { ...common, verdict: 'GROWTH_OBSERVED', reason: 'all measured windows and late slope grow above noise' };
    return { ...common, verdict: 'INCONCLUSIVE', reason: 'non-plateau shape without uniform sustained growth' };
}

export function parseBurstArgs(args: string[]): { label: string; executable: string; evidenceRoot: string } {
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index], value = args[index + 1];
        if (!key || !['--label', '--browser-executable', '--evidence-root'].includes(key) || !value || values.has(key))
            throw Error('unknown, duplicate or incomplete arguments');
        values.set(key, value);
    }
    const label = values.get('--label') ?? '', executable = values.get('--browser-executable') ?? '';
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(label) || !path.isAbsolute(executable)) throw Error('safe label and absolute browser executable required');
    const evidenceRoot = path.resolve(values.get('--evidence-root') ?? path.join(ROOT, '.codexclaw/evidence/native-activity-burst'));
    const allowed = path.join(ROOT, '.codexclaw/evidence');
    if (evidenceRoot !== allowed && !evidenceRoot.startsWith(allowed + path.sep)) throw Error('evidence root must be repository-owned');
    return { label, executable, evidenceRoot };
}

export type BrowserOracleSample = Pick<BurstBrowserSnapshot, 'receivedCount' | 'ingestedCount' | 'retiredCallbackHits'
    | 'suppressedIngestions' | 'terminal' | 'activeEventSources' | 'maxEventSources' | 'errors' | 'bulk' | 'final'
    | 'binding' | 'finalText' | 'finalDomRaw' | 'finalDomText' | 'answerCount' | 'controls'>;
// Exact request identities cross disposal; URL similarity alone never retires a failure.
export function probeRequestTracker<T extends { url(): string; method(): string }>(origin: string) {
    const active = new Set<T>(), retired = new WeakSet<T>();
    let disposing = false;
    const owned = (request: T) => {
        const url = new URL(request.url());
        return request.method() === 'GET' && url.origin === origin
            && (/^\/(?:__probe\/metrics|api\/events|api\/auth\/token|api\/i18n\/(?:en|ko))$/.test(url.pathname)
                || /^\/api\/traces\/tr_[A-Za-z0-9_-]+\/events\/[1-9]\d*$/.test(url.pathname));
    };
    return {
        started(request: T) { if (owned(request)) { active.add(request); if (disposing) retired.add(request); } },
        finished(request: T) { active.delete(request); },
        beginDisposal() { disposing = true; for (const request of active) retired.add(request); },
        endDisposal() { disposing = false; },
        failed(request: T, error: string | undefined) {
            active.delete(request);
            return { retired: retired.has(request), duringDisposal: disposing,
                expected: retired.has(request) && error === 'net::ERR_ABORTED' };
        },
    };
}
export function browserFailures(value: BrowserOracleSample): string[] {
    const failures: string[] = [];
    const check = (condition: boolean, name: string) => { if (!condition) failures.push(name); };
    check(value.receivedCount === 643, 'received-count'); check(value.ingestedCount === 643, 'ingested-count');
    check(value.retiredCallbackHits === 0, 'retired-subscriber'); check(value.suppressedIngestions === 0, 'suppressed-ingestion');
    check(value.terminal, 'terminal'); check(value.activeEventSources === 1 && value.maxEventSources === 1, 'event-source-count');
    check(value.errors.length === 0, 'browser-errors');
    const bulk = value.bulk, final = value.final;
    check(!!bulk && bulk.entryCount === 16 && bulk.retainedChars === 65536 && bulk.observedFieldChars === 65536
        && bulk.omittedEntries === 496 && bulk.omittedTextChars === 4608 && bulk.latestAction === 'tool-0511 (done)', 'bulk-bounds');
    check(!!final && final.entryCount === 128 && final.retainedChars === 1408 && final.observedFieldChars === 1408
        && final.omittedEntries === 513 && final.omittedTextChars === 4608 && final.latestAction === 'tail-0128 (done)', 'tail-bounds');
    const expectedIds = Array.from({ length: 128 }, (_, index) => `tail-${String(index + 1).padStart(4, '0')}`);
    check(JSON.stringify(final?.retainedIds) === JSON.stringify(expectedIds), 'retained-identities');
    check(final?.visibleRows === 8 && final.omissionVisible, 'latest-page');
    const expected = value.binding ? `WP29 cycle ${String(value.binding.cycle.index).padStart(2, '0')} final` : null;
    check(expected !== null && value.finalText === expected && value.finalDomRaw === expected
        && value.finalDomText === expected && value.answerCount === 1, 'final-owner');
    check(value.controls.some(control => control.completedAt !== null && control.frameAt !== null
        && control.completedOrdinal !== null && control.frameOrdinal !== null
        && control.completedAt >= control.queuedAt && control.frameAt >= control.completedAt
        && control.completedOrdinal >= control.queuedOrdinal && control.frameOrdinal >= control.completedOrdinal
        && control.frameOrdinal < 513 && value.receivedCount > control.frameOrdinal), 'control-frame-progress');
    return failures;
}

async function bounded<T>(promise: Promise<T>, timeout: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error(`${label} timeout`)), timeout);
    })]); } finally { clearTimeout(timer!); }
}

interface OwnedChild {
    child: ChildProcess; owner: OwnedProcess; closed: Promise<void>; didClose: boolean; alive: boolean;
    code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; failure: string | null;
}
function ownedChild(executable: string, args: string[], env: NodeJS.ProcessEnv, ipc = false): OwnedChild {
    const child = spawn(executable, args, { cwd: ROOT, env, detached: true,
        stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    let alive = true;
    const owner = new OwnedProcess(child, { terminateTree: (_pid, signal = 'SIGTERM') => {
        if (alive && child.exitCode === null && child.signalCode === null) child.kill(signal);
    } });
    const result = { child, owner, didClose: false, alive: true, code: null, signal: null,
        stdout: '', stderr: '', failure: null } as Omit<OwnedChild, 'closed'> & { closed?: Promise<void> };
    const retire = () => { alive = false; result.alive = false; owner.complete(); };
    child.once('exit', retire); child.once('error', error => { result.failure = error.message; retire(); });
    result.closed = new Promise(resolve => child.once('close', (code, signal) => {
        result.didClose = true; result.code = code; result.signal = signal;
        if ((code !== 0 || signal !== null) && result.failure === null) result.failure = `unsuccessful child exit:${code}:${signal}`;
        retire(); resolve();
    }));
    for (const name of ['stdout', 'stderr'] as const) {
        let bytes = 0;
        child[name]!.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes <= LOG_BYTES) result[name] += chunk.toString();
            else { result.failure = `${name} output limit`; owner.terminate('output-limit'); }
        });
    }
    return result as OwnedChild;
}

function safeEvidenceDirectory(parent: string, label: string): string {
    let cursor = ROOT;
    for (const part of path.relative(ROOT, parent).split(path.sep)) {
        cursor = path.join(cursor, part);
        if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('unsafe evidence ancestor');
    }
    const directory = path.join(parent, label); fs.mkdirSync(directory); return fs.realpathSync(directory);
}

function sourceHashes(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const directory of ['src', 'public/js', 'public/css', 'types'])
        for (const entry of fs.readdirSync(path.join(ROOT, directory), { recursive: true, withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const filename = path.join(entry.parentPath, entry.name);
            result[path.relative(ROOT, filename)] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
        }
    for (const relative of ['package.json', 'package-lock.json', 'public/index.html',
        'tests/fixtures/native-activity-burst-server.mts', 'tests/fixtures/web-activity-burst.ts',
        'tests/smoke/native-activity-burst.mts', 'tests/unit/native-activity-burst-fixture.test.ts',
        ...['playwright-core', 'vite', 'tsx', 'express', 'better-sqlite3'].map(name => `node_modules/${name}/package.json`)])
        result[relative] = createHash('sha256').update(fs.readFileSync(path.join(ROOT, relative))).digest('hex');
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

interface Sample {
    node: number; renderer: number | null; rendererIdentity: string | null;
    rendererIssue: string | null; heap: unknown; dom: unknown; producer: BurstMetrics;
}

export async function runBurst(args: string[]): Promise<number> {
    const options = parseBurstArgs(args);
    if (!['darwin', 'linux'].includes(process.platform)) throw Error('this OS RSS probe supports darwin/linux only');
    if (!fs.statSync(options.executable).isFile()) throw Error('browser executable is not a file');
    const output = safeEvidenceDirectory(options.evidenceRoot, options.label);
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-burst-')));
    const env: NodeJS.ProcessEnv = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'C',
        NO_COLOR: '1', CLI_JAW_SKIP_AUTOMATION_PRIME: '1', JAW_OPEN_BROWSER: '0', JAW_DASHBOARD_OPEN: '0', JAW_SKILLS_SOURCE: 'local' };
    for (const [key, relative] of Object.entries({ HOME: 'home', CLI_JAW_HOME: 'jaw', CLI_JAW_DASHBOARD_HOME: 'dashboard',
        TMPDIR: 'tmp', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state',
        CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude', PI_CODING_AGENT_DIR: 'pi', npm_config_cache: 'npm' })) {
        env[key] = path.join(scratch, relative); fs.mkdirSync(env[key]!);
    }
    const project = path.join(scratch, 'project'), profile = path.join(scratch, 'browser');
    fs.mkdirSync(project); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(env['CLI_JAW_HOME']!, 'settings.json'), JSON.stringify({ workingDir: project,
        messaging: { enabledChannels: [], homeChannel: null }, memory: { enabled: false }, locale: 'en' }));
    fs.writeFileSync(path.join(env['CLI_JAW_HOME']!, 'mcp.json'), '{"servers":{}}');
    fs.writeFileSync(path.join(env['CLI_JAW_HOME']!, 'heartbeat.json'), '{"jobs":[]}');
    // Import-time config, DB, Vite and Playwright all see only this owned environment.
    process.env = env;
    const nonce = randomBytes(32).toString('hex');
    const outputStat = fs.statSync(output);
    const write = (name: string, value: unknown) => {
        const now = fs.lstatSync(output);
        assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.dev === outputStat.dev && now.ino === outputStat.ino);
        fs.writeFileSync(path.join(output, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { flag: 'wx' });
    };
    const sourceBefore = sourceHashes();
    const commit = execFileSync('git', ['--work-tree=' + ROOT, 'rev-parse', 'HEAD'], { cwd: ROOT, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 3000 }).trim();
    const dirty = execFileSync('git', ['--work-tree=' + ROOT, 'status', '--porcelain', '--untracked-files=all'],
        { cwd: ROOT, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 3000 }).trim() !== '';
    write('source-before.json', { commit, dirty, sources: sourceBefore, node: process.versions.node, platform: process.platform, scratch });
    const pageBytes = Number(execFileSync('getconf', ['PAGESIZE'], { env, encoding: 'utf8', timeout: 3000 }).trim());
    assert.ok(Number.isSafeInteger(pageBytes) && pageBytes > 0);
    const abort = new AbortController();
    const watchdog = setTimeout(() => abort.abort(Error('whole invocation watchdog')), LIMIT_MS);
    const interrupt = () => abort.abort(Error('operator signal'));
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    let producer: OwnedChild | undefined, chrome: OwnedChild | undefined, browser: Browser | undefined;
    let context: BrowserContext | undefined, page: Page | undefined, browserCdp: CDPSession | undefined, pageCdp: CDPSession | undefined;
    let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
    let server: http.Server | undefined, uiOrigin = '', producerOrigin = '', closing = false;
    let fatal: string | null = null, nodeMemory: MemoryVerdict | null = null, rendererMemory: MemoryVerdict | null = null;
    let rendererIdentity: string | null = null, rendererStable = true;
    let producerStopped: Record<string, unknown> | null = null;
    const unexpected: string[] = [], cycles: unknown[] = [], preflight: unknown[] = [];
    const initial: Sample[][] = [], measured: Sample[][] = [], final: Sample[][] = [];
    const sockets = new Set<import('node:net').Socket>(), upstream = new Set<http.ClientRequest>();
    let requests: ReturnType<typeof probeRequestTracker<BrowserRequest>> | undefined;
    const requestFailures: unknown[] = [];
    const fail = (message: string) => { if (unexpected.length < 64) unexpected.push(message.slice(0, 500)); };
    const ensureLive = () => {
        abort.signal.throwIfAborted();
        if (producer && (!producer.alive || producer.failure)) throw Error(`producer retired:${producer.failure ?? producer.code}`);
        if (chrome && (!chrome.alive || chrome.failure)) throw Error(`browser retired:${chrome.failure ?? chrome.code}`);
    };
    async function control<T>(route: string, body?: unknown, overrideNonce = nonce): Promise<T> {
        ensureLive();
        const response = await fetch(producerOrigin + route, { method: body === undefined ? 'GET' : 'POST',
            headers: { [HEADER]: overrideNonce, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
        const reader = response.body?.getReader(); if (!reader) throw Error('control response has no body');
        const chunks: Uint8Array[] = []; let bytes = 0;
        try { while (true) {
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.byteLength; if (bytes > 32768) throw Error('control response bound'); chunks.push(next.value);
        } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (!response.ok) throw Error(`control HTTP${response.status}`);
        const value = JSON.parse(Buffer.concat(chunks).toString()) as { ok?: boolean; data?: T };
        if (value.ok !== true || (value.data === undefined && !['/__probe/start', '/__probe/settle', '/__probe/stop'].includes(route))) throw Error('control envelope');
        // Only acknowledgement routes permit an absent payload; typed consumers
        // validate their concrete fields after this JSON-envelope boundary.
        return value.data as T;
    }
    const snapshot = async () => {
        const value = await bounded(page!.evaluate(() => window.__wp29Probe.snapshot()), 5000, 'browser snapshot');
        if (Buffer.byteLength(JSON.stringify(value)) > 32768) throw Error('browser snapshot bound');
        return value;
    };
    async function waitFor(predicate: () => Promise<boolean>, name: string, timeout = 5000): Promise<void> {
        const until = Date.now() + timeout;
        while (!await predicate()) {
            ensureLive(); if (Date.now() >= until) throw Error(`${name} timeout`);
            await new Promise<void>(resolve => setTimeout(resolve, 20));
        }
    }
    async function barriers(): Promise<void> {
        ensureLive();
        await bounded(page!.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 5000, 'browser scheduling barriers');
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    async function sampleCheckpoint(): Promise<Sample[]> {
        const samples: Sample[] = [];
        for (let index = 0; index < 5; index++) {
            await barriers(); const metrics = await control<BurstMetrics>('/__probe/metrics');
            assert.equal(metrics.resources.traceRuns, 0); assert.equal(metrics.resources.traceEvents, 0);
            assert.equal(metrics.resources.runtimeRows, 0); assert.equal(metrics.resources.runtimeBytes, 0);
            assert.equal(metrics.resources.busListeners, 1); assert.equal(metrics.resources.heartbeatIntervals, 0);
            assert.equal(metrics.sse.activeConnections, 0); assert.equal(metrics.resources.pendingBatches, 0);
            assert.equal(metrics.resources.ringCount, 1000); assert.equal(metrics.resources.watermarkCount, 3);
            const info = await browserCdp!.send('SystemInfo.getProcessInfo');
            const pids = info.processInfo.filter(value => value.type === 'renderer').map(value => value.id).sort((a, b) => a - b);
            let rss: number | null = null, identity: string | null = null, rendererIssue: string | null = null;
            if (pids.length && pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) {
                try {
                const rows = execFileSync('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,rss=,lstart='],
                    { env, encoding: 'utf8', timeout: 3000 }).trim().split('\n').map(line => line.trim().split(/\s+/));
                if (rows.length === pids.length && rows.every(row => pids.includes(Number(row[0])) && Number(row[1]) > 0 && row.length >= 7)) {
                    rss = rows.reduce((total, row) => total + Number(row[1]) * 1024, 0);
                    identity = rows.map(row => `${row[0]}:${row.slice(2).join(' ')}`).sort().join('|');
                }
                } catch (error) { rendererIssue = String(error).slice(0, 300); }
            }
            if (!identity) rendererStable = false;
            else if (rendererIdentity === null) rendererIdentity = identity;
            else if (rendererIdentity !== identity) rendererStable = false;
            samples.push({ node: metrics.memory.rss, renderer: rss, rendererIdentity: identity, rendererIssue,
                heap: await pageCdp!.send('Runtime.getHeapUsage'), dom: await pageCdp!.send('Memory.getDOMCounters'), producer: metrics });
        }
        return samples;
    }
    try {
        const { createServer } = await import('vite');
        const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
        const styles = [...indexHtml.matchAll(/href="(\/css\/[^" ]+\.css)"/g)].map(match => '/public' + match[1]);
        const header = indexHtml.slice(indexHtml.indexOf('<div class="chat-header">'), indexHtml.indexOf('<div class="pabc-roadmap"'));
        const html = `<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activity burst fixture</title>
            ${styles.map(href => `<link rel="stylesheet" href="${href}">`).join('')}
            <body><nav class="sidebar-left">Burst fixture</nav><main class="chat-area">${header}<div id="statusBadge"></div>
            <div id="chatMessages" class="chat-messages"></div><div id="typingIndicator"><span class="label"></span></div>
            <div class="chat-input-area"><textarea id="chatInput" aria-label="Fixture composer" disabled></textarea><button id="btnSend" disabled>Fixture only</button></div>
            </main><aside class="sidebar-right">Controlled canonical events</aside>
            <script type="module" src="/tests/fixtures/web-activity-burst.ts"></script></body></html>`;
        const cacheDir = path.join(scratch, 'vite-cache');
        vite = await createServer({ configFile: false, envFile: false, root: ROOT, publicDir: false, appType: 'custom', cacheDir,
            logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null, cors: false,
                fs: { strict: true, allow: [ROOT, cacheDir] } }, optimizeDeps: { entries: [path.join(ROOT, 'tests/fixtures/web-activity-burst.ts')] } });
        server = http.createServer((req, res) => {
            const requestUrl = new URL(req.url ?? '/', uiOrigin || 'http://127.0.0.1');
            const pathname = requestUrl.pathname;
            const reply = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
            if (requestUrl.origin !== uiOrigin || req.headers.host !== new URL(uiOrigin).host) return reply(403, { error: 'fixture_origin' });
            if (pathname === '/api/auth/token') return reply(200, { token: '' });
            if (/^\/api\/i18n\/(en|ko)$/.test(pathname)) return reply(200,
                JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales', pathname.split('/').at(-1)! + '.json'), 'utf8')));
            if (pathname.startsWith('/api/') || pathname.startsWith('/__probe/')) {
                if (!producerOrigin) return reply(503, { error: 'producer_pending' });
                if (!(pathname === '/api/events' || pathname.startsWith('/api/traces/') || pathname.startsWith('/__probe/'))
                    || !['GET', 'POST'].includes(req.method ?? '')) return reply(403, { error: 'fixture_api' });
                const target = new URL(req.url!, producerOrigin);
                const headers: http.OutgoingHttpHeaders = { host: target.host };
                for (const key of ['cookie', 'origin', 'content-type', 'last-event-id', HEADER]) if (req.headers[key] !== undefined) headers[key] = req.headers[key];
                let cancelled = false;
                const outgoing = http.request(target, { method: req.method, headers, agent: false }, response => {
                    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
                    response.once('error', () => { if (!res.destroyed) res.destroy(); });
                });
                upstream.add(outgoing); outgoing.once('close', () => upstream.delete(outgoing));
                outgoing.once('error', error => { if (!closing && !cancelled) fail(`proxy:${error.message}`); if (!res.headersSent) reply(502, { error: 'proxy' }); else res.destroy(); });
                req.once('aborted', () => { cancelled = true; outgoing.destroy(); });
                res.once('close', () => { cancelled = true; outgoing.destroy(); }); req.pipe(outgoing); return;
            }
            if (!['GET', 'HEAD'].includes(req.method ?? '')) return reply(405, { error: 'fixture_method' });
            if (pathname === '/burst-fixture') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); return; }
            if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
            let relative = pathname;
            if (/^\/(css|assets|fonts|images|vendor)\//.test(relative)) relative = '/public' + relative;
            const candidate = path.resolve(relative.startsWith('/@fs/') ? relative.slice(4) : path.join(ROOT, relative));
            const allowed = (file: string) => file === path.join(ROOT, 'tests/fixtures/web-activity-burst.ts')
                || ['public', 'src/shared', 'node_modules'].some(root => file.startsWith(path.join(ROOT, root) + path.sep))
                || file.startsWith(cacheDir + path.sep);
            const special = ['/@vite/client', '/@id/__x00__vite-browser-external'].includes(pathname);
            if (!special && (!allowed(candidate) || !/\.(?:[cm]?jsx?|tsx?|css|map|svg|png|jpe?g|webp|ico|woff2?|ttf)$/.test(candidate)
                || (fs.existsSync(candidate) && !allowed(fs.realpathSync(candidate))))) return reply(403, { error: 'fixture_source' });
            req.url = relative + requestUrl.search; vite!.middlewares(req, res, () => reply(404, { error: 'fixture_missing' }));
        });
        server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
        await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
        const address = server.address(); assert.ok(address && typeof address !== 'string'); uiOrigin = `http://127.0.0.1:${address.port}`;
        producer = ownedChild(process.execPath, ['--import', 'tsx', path.join(ROOT, 'tests/fixtures/native-activity-burst-server.mts')], env, true);
        producer.child.on('message', message => {
            if (message && typeof message === 'object' && 'kind' in message && message.kind === 'stopped')
                producerStopped = message as Record<string, unknown>;
        });
        const ready = bounded(new Promise<Record<string, unknown>>((resolve, reject) => {
            producer!.child.once('error', reject);
            producer!.child.once('close', () => reject(Error('producer closed before ready')));
            producer!.child.on('message', message => {
                if (!message || typeof message !== 'object' || !('kind' in message)) return;
                if (message.kind === 'ready') resolve(message as Record<string, unknown>);
                else if (message.kind === 'failed') reject(Error('producer startup failed'));
            });
        }), 15000, 'producer ready');
        producer.child.send!({ protocol: PROTOCOL, nonce, uiOrigin }, error => { if (error) { producer!.failure = error.message; abort.abort(error); } });
        const info = await ready;
        assert.equal(info['pid'], producer.child.pid); assert.equal(info['protocol'], PROTOCOL);
        const origin = new URL(String(info['origin'])); assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1'); assert.ok(Number(origin.port) > 0);
        producerOrigin = origin.origin;
        assert.equal(fs.realpathSync(String(info['home'])), fs.realpathSync(env['CLI_JAW_HOME']!));
        write('producer-ready.json', info);
        chrome = ownedChild(options.executable, [`--user-data-dir=${profile}`, '--headless=new', '--remote-debugging-port=0',
            '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
            '--disable-sync', '--disable-extensions', '--disable-default-apps', '--password-store=basic', '--use-mock-keychain', 'about:blank'], env);
        const portFile = path.join(profile, 'DevToolsActivePort');
        await waitFor(async () => fs.existsSync(portFile), 'browser endpoint', 15000);
        const [port, id] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
        assert.ok(Number.isInteger(Number(port)) && Number(port) > 0 && Number(port) < 65536 && /^\/devtools\/browser\/[a-z0-9-]+$/i.test(id ?? ''));
        const endpoint = `ws://127.0.0.1:${port}${id}`;
        const { chromium } = await import('playwright-core');
        browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 }); ensureLive();
        context = await bounded(browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' }), 15000, 'browser context');
        await context.route('**/*', route => {
            const value = route.request().url();
            if (value.startsWith(uiOrigin + '/') || /^(data:|blob:)/.test(value)) return route.continue();
            fail('blocked foreign browser request:' + new URL(value).origin); return route.abort('blockedbyclient');
        });
        await context.addCookies([{ name: COOKIE, value: nonce, url: uiOrigin, httpOnly: true, sameSite: 'Strict' }]);
        page = await bounded(context.newPage(), 15000, 'browser page');
        page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(15000);
        page.on('pageerror', error => fail('page:' + error.message));
        page.on('crash', () => { fail('renderer crashed'); abort.abort(Error('renderer crashed')); });
        page.on('console', message => { if (message.type() === 'error') fail('console:' + message.text()); });
        requests = probeRequestTracker<BrowserRequest>(uiOrigin);
        page.on('request', request => requests!.started(request));
        page.on('requestfinished', request => requests!.finished(request));
        page.on('requestfailed', request => {
            const error = request.failure()?.errorText;
            const classification = requests!.failed(request, error);
            if (requestFailures.length < 64) requestFailures.push({ url: request.url().slice(0, 200), error, ...classification });
            if (!classification.expected) fail('request:' + request.url().slice(0, 200) + ':' + error);
        });
        await page.goto(uiOrigin + '/burst-fixture', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForFunction(() => typeof window.__wp29Probe?.prepare === 'function', undefined, { timeout: 15000 });
        browserCdp = await browser.newBrowserCDPSession(); pageCdp = await context.newCDPSession(page);
        write('spec.json', { protocol: PROTOCOL, workload: '512x4096+129-small-v1', preflight: 5, warmup: 5, measured: 20,
            initialIdle: 5, finalIdle: 5, pageBytes, cycleMs: CYCLE_MS, limitMs: LIMIT_MS, fixtureOrigin: uiOrigin,
            producerOrigin, producerPid: producer.child.pid, browserPid: chrome.child.pid, browserExecutable: fs.realpathSync(options.executable),
            versions: { node: process.versions.node, browser: await browser.version() }, scope: 'canonical writer/store/SSE/Activity, not actual providers or packaged Electron' });
        await assert.rejects(control('/__probe/metrics', undefined, 'invalid'), /HTTP403/);
        const beforeInvalid = await control<BurstMetrics>('/__probe/metrics');
        await assert.rejects(control('/__probe/prepare', { cycle: { phase: 'unknown', index: 1 } }), /HTTP400/);
        assert.equal((await control<BurstMetrics>('/__probe/metrics')).committed, beforeInvalid.committed);
        const runCycle = async (cycle: BurstCycle): Promise<void> => {
            const started = Date.now();
            const binding = await control<BurstBinding>('/__probe/prepare', { cycle });
            assert.equal(binding.protocol, PROTOCOL); assert.deepEqual(binding.cycle, cycle);
            await bounded(page!.evaluate(binding => window.__wp29Probe.prepare(binding), binding), 15000, 'browser prepare');
            await waitFor(async () => (await control<BurstMetrics>('/__probe/metrics')).sse.activeConnections === 1, 'SSE open');
            await control('/__probe/start', { cycle });
            await page!.waitForFunction(() => window.__wp29Probe.snapshot().terminal, undefined, { timeout: CYCLE_MS });
            const value = await snapshot(), problems = browserFailures(value);
            if (cycle.phase === 'preflight' && cycle.index === 3) {
                assert.deepEqual(problems, ['retired-subscriber']); assert.equal(value.receivedCount, 643); assert.equal(value.ingestedCount, 643);
            } else if (cycle.phase === 'preflight' && cycle.index === 4) {
                assert.ok(problems.includes('ingested-count')); assert.equal(value.receivedCount, 643); assert.equal(value.ingestedCount, 642);
            } else assert.deepEqual(problems, [], 'functional browser oracles');
            const metrics = await control<BurstMetrics>('/__probe/metrics');
            for (const key of ['attempted', 'committed', 'published'] as const) assert.equal(metrics[key], 643);
            assert.equal(metrics.submittedOutputBytes, OUTPUT_BYTES + 258); assert.ok(metrics.committedCanonicalBytes >= 1048576);
            assert.ok(metrics.storedRuntimeBytes < 4 * 1024 * 1024); assert.equal(metrics.resources.runtimeRows, 643);
            assert.equal(metrics.resources.traceEvents, 644); assert.equal(metrics.sse.slowClientClosed, 0); assert.equal(metrics.sse.replayGapCount, 0);
            await page!.getByRole('button', { name: 'Inspect retained activity in Trace' }).click();
            await waitFor(async () => (await snapshot()).rawProof.length === 2, 'raw proof');
            const withRaw = await snapshot();
            const early = withRaw.rawProof.find(row => row.seq === metrics.firstBulkTraceSeq);
            const late = withRaw.rawProof.find(row => row.seq === metrics.lastTailTraceSeq);
            assert.equal(early?.runId, binding.runId); assert.equal(early?.outputBytes, 4096);
            assert.equal(early?.prefix, `C${String(cycle.index).padStart(2, '0')}B0000|`); assert.equal(early?.suffix, '|END0000');
            assert.equal(late?.runId, binding.runId); assert.equal(late?.outputBytes, 2);
            if (cycle.phase === 'preflight' && cycle.index === 1) {
                // Frozen actual checkpoint DOM, not a screenshot racing live delivery.
                const capture = await page!.evaluate(() => window.__wp29Probe.takeBulkCapture());
                assert.equal(capture.receivedCount, 513);
                assert.ok(capture.html.length > 0 && Buffer.byteLength(capture.html) <= 131072);
                const capturePage = await context!.newPage();
                try {
                    await capturePage.setContent(`<base href="${uiOrigin}/">${styles.map(href => `<link rel="stylesheet" href="${href}">`).join('')}<main>${capture.html}</main>`);
                    await capturePage.locator('.activity-disclosure > summary').focus();
                    if (!await capturePage.locator('.activity-disclosure').evaluate(element => (element as HTMLDetailsElement).open)) await capturePage.keyboard.press('Enter');
                    await capturePage.locator('.activity-item > summary').first().click();
                    assert.equal(await capturePage.locator('.activity-item').count(), 16);
                    await capturePage.screenshot({ path: path.join(output, 'preflight-bulk.png') });
                } finally { await capturePage.close(); }
                write('preflight-capture-window.json', { receivedCount: capture.receivedCount, mode: 'frozen bulk checkpoint DOM; not live presentation timing' });
                const summary = page!.locator('.activity-disclosure > summary'); await summary.focus();
                if (!await page!.locator('.activity-disclosure').evaluate(element => (element as HTMLDetailsElement).open)) await page!.keyboard.press('Enter');
                await page!.getByRole('button', { name: 'Earlier activity', exact: true }).click();
                assert.equal(await page!.locator('.activity-item').count(), 40);
                await page!.screenshot({ path: path.join(output, 'preflight-earlier.png') });
                await page!.getByRole('button', { name: 'Later activity', exact: true }).click();
                assert.equal(await page!.locator('.activity-item').count(), 8);
                await page!.locator('.activity-item > summary').last().click();
                assert.equal(await page!.locator('.activity-item-text').last().innerText(), 'ok');
                await page!.screenshot({ path: path.join(output, 'preflight-latest.png') });
                await assert.rejects(control(`/api/traces/${binding.runId}/events/${metrics.firstBulkTraceSeq}?session=wrong-session`), /HTTP404/);
            }
            requests!.beginDisposal();
            const disposal = await bounded(page!.evaluate(() => window.__wp29Probe.disposeCycle()), 5000, 'browser disposal')
                .finally(() => requests!.endDisposal());
            assert.equal(disposal.activeEventSources, 0); assert.equal(disposal.rootConnected, false); assert.equal(disposal.handlerCount, 0);
            assert.deepEqual(disposal.errors, []);
            assert.equal(disposal.retiredPending, cycle.phase === 'preflight' && cycle.index === 2);
            await waitFor(async () => (await control<BurstMetrics>('/__probe/metrics')).sse.activeConnections === 0, 'SSE closed');
            await control('/__probe/settle', { cycle, lastObservedTraceSeq: metrics.terminalTraceSeq, receivedCount: value.receivedCount });
            assert.ok(Date.now() - started <= CYCLE_MS, 'cycle deadline');
            const record = { cycle, binding, browser: withRaw, producer: metrics, disposal, problems, elapsedMs: Date.now() - started };
            if (cycle.phase === 'preflight') preflight.push(record);
            else cycles.push({ cycle, problems, elapsedMs: record.elapsedMs, artifact: `${cycle.phase}-${String(cycle.index).padStart(2, '0')}.json` });
            write(`${cycle.phase}-${String(cycle.index).padStart(2, '0')}.json`, record);
            console.log(`${cycle.phase} ${cycle.index}: ${cycle.phase === 'preflight' && [3, 4].includes(cycle.index) ? 'expected oracle rejection' : 'functional PASS'}`);
        };
        for (let index = 1; index <= 5; index++) await runCycle({ phase: 'preflight', index });
        for (let index = 1; index <= 5; index++) await runCycle({ phase: 'warmup', index });
        for (let index = 0; index < 5; index++) initial.push(await sampleCheckpoint());
        for (let index = 1; index <= 20; index++) { await runCycle({ phase: 'measured', index }); measured.push(await sampleCheckpoint()); }
        for (let index = 0; index < 5; index++) final.push(await sampleCheckpoint());
        const medians = (groups: Sample[][], key: 'node' | 'renderer') => groups.map(group => median(group.map(row => row[key] ?? NaN)));
        nodeMemory = classifyMemory({ initial: medians(initial, 'node'), measured: medians(measured, 'node'), final: medians(final, 'node'), pageBytes, identityStable: true });
        rendererMemory = rendererStable ? classifyMemory({ initial: medians(initial, 'renderer'), measured: medians(measured, 'renderer'), final: medians(final, 'renderer'), pageBytes, identityStable: true })
            : classifyMemory({ initial: [], measured: [], final: [], pageBytes, identityStable: false });
        assert.deepEqual(unexpected, [], 'unexpected page/network errors');
    } catch (error) { fatal = error instanceof Error ? error.message : String(error); }
    finally {
        clearTimeout(watchdog); closing = true;
        requests?.beginDisposal();
        const cleanupErrors: string[] = [];
        const clean = async (name: string, action: () => Promise<unknown>) => { try { await bounded(action(), 5000, name); } catch (error) { cleanupErrors.push(`${name}:${String(error)}`.slice(0, 500)); } };
        if (page && !page.isClosed()) await clean('page disposal', async () => { await page!.evaluate(() => window.__wp29Probe?.disposeCycle()); });
        if (context) await clean('context close', () => context!.close());
        if (chrome?.alive && browserCdp) await clean('Browser.close', () => browserCdp!.send('Browser.close').catch(error => {
            if (chrome!.alive) throw error;
        }));
        if (browser) await clean('CDP disconnect', () => browser!.close());
        if (producer?.alive && producer.child.connected) producer.child.send!({ kind: 'stop' }, error => { if (error) cleanupErrors.push('producer stop IPC:' + error.message); });
        for (const [name, owned] of [['producer', producer], ['browser', chrome]] as const) if (owned) {
            try { await bounded(owned.closed, 5000, `${name} cooperative close`); }
            catch { owned.owner.terminate('shutdown'); await clean(`${name} retained close`, () => owned.closed); }
        }
        for (const request of upstream) request.destroy();
        if (server) { server.closeAllConnections(); await clean('UI server close', () => new Promise<void>(resolve => server!.close(() => resolve()))); }
        if (vite) await clean('Vite close', () => vite!.close());
        for (const owned of [producer, chrome]) if (owned && !owned.didClose) {
            if (owned.child.connected) owned.child.disconnect();
            owned.child.stdout?.destroy(); owned.child.stderr?.destroy(); owned.child.unref();
        }
        process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
        const children = [producer, chrome].filter((value): value is OwnedChild => !!value).map(owned => {
            let groupAbsent = false;
            try { process.kill(-owned.child.pid!, 0); } catch (error) { groupAbsent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
            return { pid: owned.child.pid, closed: owned.didClose, code: owned.code, signal: owned.signal, groupAbsent, failure: owned.failure };
        });
        let sourcesStable = false;
        try { const after = sourceHashes(); write('source-after.json', { sources: after }); sourcesStable = JSON.stringify(sourceBefore) === JSON.stringify(after); }
        catch (error) { cleanupErrors.push('source check:' + String(error)); }
        for (const [name, owned] of [['producer', producer], ['browser', chrome]] as const) if (owned) {
            write(`${name}.stdout.log`, owned.stdout); write(`${name}.stderr.log`, owned.stderr);
        }
        const stopped = producerStopped as Record<string, unknown> | null;
        if (stopped) write('producer-stop.json', stopped);
        const producerResources = stopped?.['resources'];
        const dbClosed = stopped?.['kind'] === 'stopped' && stopped['protocol'] === PROTOCOL && stopped['pid'] === producer?.child.pid
            && stopped['closed'] === true && stopped['httpClosed'] === true && stopped['dbOpen'] === false
            && producerResources !== null && typeof producerResources === 'object' && !Array.isArray(producerResources)
            && Object.keys(producerResources).length === 5
            && ['activeSse', 'busListeners', 'heartbeatIntervals', 'sockets', 'pendingBatches']
                .every(key => (producerResources as Record<string, unknown>)[key] === 0);
        const certified = dbClosed && cleanupErrors.length === 0 && children.length === 2 && children.every(row => row.closed && row.groupAbsent && !row.failure)
            && !server?.listening && sockets.size === 0 && upstream.size === 0;
        write('teardown.json', { children, cleanupErrors, certified, scratch, rootDisposition: 'retained-by-policy',
            dbClosed, uiListening: server?.listening ?? false, sockets: sockets.size, upstream: upstream.size, sourcesStable, at: new Date().toISOString() });
        write('samples.json', { initial, measured, final, rendererIdentity, rendererStable });
        write('preflight.json', preflight); write('cycles.json', cycles);
        write('request-failures.json', requestFailures);
        const summary = { functional: fatal || unexpected.length ? 'FAIL' : 'PASS', fatal, unexpected,
            nodeRss: nodeMemory, rendererRss: rendererMemory, rendererScope: 'dedicated browser renderer RSS sum, not inferred page RSS',
            cleanup: certified ? 'CERTIFIED' : 'UNCERTIFIED', sourcesStable, output,
            limits: 'canonical writer/store/SSE/Activity fixture; no provider/SDK-process/full-ws/MESSAGE/packaged-Electron or universal leak-free claim' };
        write('summary.json', summary); console.log(JSON.stringify(summary));
        if (fatal || unexpected.length || !certified || !sourcesStable) return 1;
        return nodeMemory?.verdict === 'PLATEAU_OBSERVED' && rendererMemory?.verdict === 'PLATEAU_OBSERVED' ? 0 : 3;
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    if (process.env.NODE_TEST_CONTEXT) {
        const { test } = await import('node:test');
        const args = ['--label', process.env.CLI_JAW_BURST_LABEL ?? '',
            '--browser-executable', process.env.CLI_JAW_BURST_BROWSER ?? ''];
        test('canonical Activity burst, concurrency, cleanup and RSS conformance',
            { skip: !process.env.CLI_JAW_BURST_BROWSER && !process.env.CLI_JAW_BURST_LABEL ? 'opt-in diagnostic: set CLI_JAW_BURST_BROWSER and CLI_JAW_BURST_LABEL' : false }, async () => {
            assert.equal(await runBurst(args), 0, 'inspect retained summary.json for separate functional, cleanup and RSS verdicts');
        });
    } else if (process.argv.slice(2).includes('--help')) console.log('node --import tsx tests/smoke/native-activity-burst.mts --label NAME --browser-executable ABSOLUTE_PATH [--evidence-root REPO_EVIDENCE_ROOT]\nUnder node --test, set CLI_JAW_BURST_LABEL and CLI_JAW_BURST_BROWSER.');
    else runBurst(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(String(error)); process.exitCode = 2; });
}
