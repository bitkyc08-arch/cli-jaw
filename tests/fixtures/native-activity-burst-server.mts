// Canonical writer/SQLite/SSE fixture. Importing this module performs no app work.
import type { RuntimeEventBody } from '../../src/shared/runtime-contract.ts';
import type { Request, Response, RequestHandler } from 'express';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const BURST_PROTOCOL = 'wp29-burst-v2' as const;
export const BURST_SPEC = Object.freeze({ specId: '512x4096+129-small-v1' as const,
    totalEvents: 643, bulkEvents: 512, bulkOutputBytes: 4096, tailEvents: 129, batchSize: 32,
    submittedOutputBytes: 2_097_410, preflightCycles: 5, warmupCycles: 5, measuredCycles: 20 });
export type BurstPhase = 'preflight' | 'warmup' | 'measured';
export type BurstCycle = { phase: BurstPhase; index: number };
export type BurstBinding = { protocol: typeof BURST_PROTOCOL; cycle: BurstCycle; sessionId: string;
    scope: string; runId: string; turnId: string; specId: typeof BURST_SPEC.specId };
export type BurstMetrics = {
    protocol: typeof BURST_PROTOCOL; state: 'idle' | 'prepared' | 'running' | 'terminal' | 'settled' | 'failed';
    cycle: BurstCycle | null; binding: BurstBinding | null;
    attempted: number; committed: number; published: number; submittedOutputBytes: number;
    committedCanonicalBytes: number; storedRuntimeBytes: number;
    firstBulkTraceSeq: number | null; lastTailTraceSeq: number | null; terminalTraceSeq: number | null;
    firstBusId: number | null; lastBusId: number | null;
    producerDurationMs: number; batchHighWaterMs: number; writableHighWaterBytes: number;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
    sse: { activeConnections: number; droppedInternalTopicEvents: number; slowClientClosed: number; replayGapCount: number };
    resources: { busListeners: number; heartbeatIntervals: number; ringCount: number; currentBusId: number;
        watermarkCount: number; traceRuns: number; traceEvents: number; runtimeRows: number; runtimeBytes: number;
        dbBytes: number; walBytes: number; pendingBatches: number; rawReads: number };
    failure: string | null;
};
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function isBurstCycle(value: unknown): value is BurstCycle {
    if (!exact(value, ['phase', 'index']) || !Number.isSafeInteger(value.index)) return false;
    return (value.phase === 'preflight' || value.phase === 'warmup' || value.phase === 'measured')
        && Number(value.index) >= 1 && Number(value.index) <= (value.phase === 'measured' ? 20 : 5);
}
export function nextBurstCycle(previous: BurstCycle | null): BurstCycle | null {
    if (previous === null) return { phase: 'preflight', index: 1 };
    if (!isBurstCycle(previous)) throw new TypeError('invalid_previous_cycle');
    const limit = previous.phase === 'measured' ? 20 : 5;
    if (previous.index < limit) return { phase: previous.phase, index: previous.index + 1 };
    return previous.phase === 'preflight' ? { phase: 'warmup', index: 1 }
        : previous.phase === 'warmup' ? { phase: 'measured', index: 1 } : null;
}
export function* burstBodies(cycle: BurstCycle): Generator<RuntimeEventBody> {
    if (!isBurstCycle(cycle)) throw new TypeError('invalid_burst_cycle');
    const cc = String(cycle.index).padStart(2, '0');
    yield { kind: 'turn-start', provider: 'fixture' };
    for (let i = 0; i < 512; i++) {
        const id = String(i).padStart(4, '0');
        yield { kind: 'tool', itemId: `bulk-${id}`, name: `tool-${id}`, status: 'done',
            output: `C${cc}B${id}|${'x'.repeat(4079)}|END${id}` };
    }
    for (let i = 0; i < 129; i++) {
        const id = String(i).padStart(4, '0');
        yield { kind: 'tool', itemId: `tail-${id}`, name: `tail-${id}`, status: 'done', output: 'ok' };
    }
    yield { kind: 'turn-end', status: 'done', finalText: `WP29 cycle ${cc} final` };
}

async function main(): Promise<void> {
    const [{ default: fs }, path, { createServer }, { EventEmitter }, crypto] = await Promise.all([
        import('node:fs'), import('node:path'), import('node:http'), import('node:events'), import('node:crypto'),
    ]);
    if (!process.send || !process.connected || process.argv.length !== 2) throw Error('private_ipc_required');
    const config = await new Promise<{ nonce: string; uiOrigin: string }>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('config_timeout')), 15_000);
        const disconnected = () => finish(new Error('config_disconnected'));
        function finish(error?: Error, value?: { nonce: string; uiOrigin: string }) {
            clearTimeout(timer); process.off('message', message); process.off('disconnect', disconnected);
            if (error) reject(error); else resolve(value!);
        }
        function message(value: unknown) {
            if (!exact(value, ['protocol', 'nonce', 'uiOrigin']) || value.protocol !== BURST_PROTOCOL
                || typeof value.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(value.nonce)
                || typeof value.uiOrigin !== 'string') return finish(new Error('invalid_private_config'));
            try {
                const url = new URL(value.uiOrigin);
                if (url.origin !== value.uiOrigin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
                    || !/^[1-9]\d{0,4}$/.test(url.port) || Number(url.port) > 65535) throw Error();
            } catch { return finish(new Error('invalid_ui_origin')); }
            finish(undefined, { nonce: value.nonce, uiOrigin: value.uiOrigin });
        }
        process.on('message', message); process.once('disconnect', disconnected);
    });
    const repo = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
    const within = (root: string, candidate: string) => candidate.startsWith(root + path.sep);
    const envHome = process.env.HOME;
    if (!envHome || !path.isAbsolute(envHome)) throw Error('owned_home_required');
    const root = fs.realpathSync(path.dirname(envHome));
    if (root === repo || within(repo, root) || within(root, repo)) throw Error('separate_owned_root_required');
    for (const key of ['HOME', 'CLI_JAW_HOME', 'CLI_JAW_DASHBOARD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
        'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'npm_config_cache', 'TMPDIR']) {
        const value = process.env[key];
        if (!value || !path.isAbsolute(value) || !within(root, fs.realpathSync(value))) throw Error(`invalid_owned_path:${key}`);
    }
    const jawHome = fs.realpathSync(process.env.CLI_JAW_HOME!);
    for (const suffix of ['jaw.db', 'jaw.db-wal', 'jaw.db-shm', 'claw.db']) {
        if (fs.lstatSync(path.join(jawHome, suffix), { throwIfNoEntry: false })) throw Error('fresh_database_required');
    }
    const seed = (name: string): unknown => {
        const file = path.join(jawHome, name), info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536 || !within(jawHome, fs.realpathSync(file))) throw Error('invalid_seed_file');
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    const seeded = seed('settings.json') as Record<string, unknown>;
    if (typeof seeded.workingDir !== 'string' || !within(root, fs.realpathSync(seeded.workingDir))) throw Error('owned_project_required');
    const project = fs.realpathSync(seeded.workingDir);
    if (project === jawHome || project === fs.realpathSync(envHome)) throw Error('separate_project_required');
    const messaging = seeded.messaging as { enabledChannels?: unknown } | undefined;
    const memory = seeded.memory as { enabled?: unknown } | undefined;
    if (!Array.isArray(messaging?.enabledChannels) || messaging.enabledChannels.length || memory?.enabled !== false)
        throw Error('disabled_messaging_memory_required');
    const heartbeat = seed('heartbeat.json') as { jobs?: unknown };
    const mcp = seed('mcp.json');
    if (!Array.isArray(heartbeat.jobs) || heartbeat.jobs.length || !exact(mcp, ['servers'])
        || !exact(mcp.servers, [])) throw Error('empty_jobs_mcp_required');

    // No production/config/DB import occurs above the nonce/origin/path/seed checks.
    const { default: express } = await import('express');
    const appConfig = await import('../../src/core/config.ts');
    appConfig.loadSettings();
    if (fs.realpathSync(appConfig.JAW_HOME) !== jawHome || fs.realpathSync(path.dirname(appConfig.DB_PATH)) !== jawHome
        || fs.realpathSync(String(appConfig.settings.workingDir)) !== project) throw Error('config_identity_changed');
    const database = await import('../../src/core/db.ts');
    const { db, closeDb } = database;
    let dbCloseNeeded = true;
    let emergencyCleanup = async (): Promise<void> => {};
    try {
        const [sessions, store, writer, codec, redact, events, traces, bus] = await Promise.all([
            import('../../src/core/chat-sessions.ts'), import('../../src/trace/store.ts'),
            import('../../src/agent/runtime/events.ts'), import('../../src/trace/runtime-body-codec.ts'),
            import('../../src/trace/redact.ts'), import('../../src/routes/events.ts'),
            import('../../src/routes/traces.ts'), import('../../src/core/event-bus.ts'),
        ]);
        const app = express(); app.disable('x-powered-by');
        const server = createServer(app);
        const sockets = new Set<import('node:net').Socket>();
        const responses = new Set<Response>();
        server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
        let restoreObservation = () => {}, unsubscribeOnFailure = () => {}, cancelOnFailure = () => {};
        emergencyCleanup = async () => {
            cancelOnFailure();
            for (const response of responses) response.end();
            const closes = [...sockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())));
            for (const socket of sockets) socket.destroy();
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([Promise.all([
                    ...closes, new Promise<void>(resolve => server.close(() => resolve())),
                ]), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
            } finally { clearTimeout(timer); unsubscribeOnFailure(); restoreObservation(); }
        };
        let state: BurstMetrics['state'] = 'idle', binding: BurstBinding | null = null, previous: BurstCycle | null = null;
        let failure: string | null = null, stopping = false, stopPromise: Promise<void> | undefined;
        let batch: NodeJS.Immediate | null = null, generator: Generator<RuntimeEventBody> | null = null;
        let attempted = 0, committed = 0, published = 0, submittedOutputBytes = 0, committedCanonicalBytes = 0;
        let firstBulkTraceSeq: number | null = null, lastTailTraceSeq: number | null = null, terminalTraceSeq: number | null = null;
        let firstBusId: number | null = null, lastBusId: number | null = null, lastTraceSeq = 0;
        let producerStart = 0, producerDurationMs = 0, batchHighWaterMs = 0, writableHighWaterBytes = 0, encodedBytes = 0;
        let expectedBody: RuntimeEventBody | null = null;
        const rawReads = new Set<number>();
        const heartbeatHandles = new Set<ReturnType<typeof setInterval>>();
        const originalInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval;
        restoreObservation = () => { globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval; };
        let installingSse = false;
        globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
            const handle = Reflect.apply(originalInterval, globalThis, args) as ReturnType<typeof setInterval>;
            if (installingSse && args[1] === 15_000) heartbeatHandles.add(handle);
            return handle;
        }) as typeof setInterval;
        globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
            heartbeatHandles.delete(handle as ReturnType<typeof setInterval>); originalClearInterval(handle);
        }) as typeof clearInterval;
        const observed: { emitter: import('node:events').EventEmitter | null } = { emitter: null };
        const originalOn = EventEmitter.prototype.on;
        try {
            EventEmitter.prototype.on = function (name, listener) {
                if (name === 'event') observed.emitter = this;
                return originalOn.call(this, name, listener);
            };
            const unsubscribe = bus.subscribe(() => {}); unsubscribe();
        } finally { EventEmitter.prototype.on = originalOn; }
        if (!observed.emitter) throw Error('bus_observer_unavailable');
        const emitter = observed.emitter;
        const countStmt = db.prepare(`SELECT (SELECT COUNT(*) FROM trace_runs) traceRuns,
            (SELECT COUNT(*) FROM trace_events) traceEvents,
            (SELECT COUNT(*) FROM trace_events WHERE source='runtime') runtimeRows,
            (SELECT COALESCE(SUM(bytes),0) FROM trace_events WHERE source='runtime') runtimeBytes,
            (SELECT COALESCE(SUM(length(CAST(raw_json AS BLOB))),0) FROM trace_events WHERE source='runtime') storedRuntimeBytes`);
        type Counts = { traceRuns: number; traceEvents: number; runtimeRows: number; runtimeBytes: number; storedRuntimeBytes: number };
        const counts = () => countStmt.get() as Counts;
        const fileBytes = (file: string) => { try { return fs.statSync(file).size; } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error;
        } };
        function fail(code: string) {
            failure ??= code.slice(0, 240); state = 'failed';
            if (batch) clearImmediate(batch); batch = null; generator?.return(undefined); generator = null; expectedBody = null;
        }
        cancelOnFailure = () => { if (batch) clearImmediate(batch); batch = null; generator?.return(undefined); generator = null; };
        function metrics(): BurstMetrics {
            const rows = counts(); const memory = process.memoryUsage();
            return { protocol: BURST_PROTOCOL, state, cycle: binding?.cycle ?? null, binding,
                attempted, committed, published, submittedOutputBytes, committedCanonicalBytes, storedRuntimeBytes: rows.storedRuntimeBytes,
                firstBulkTraceSeq, lastTailTraceSeq, terminalTraceSeq, firstBusId, lastBusId,
                producerDurationMs, batchHighWaterMs, writableHighWaterBytes,
                memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers },
                sse: events.getSseMetrics(), resources: { busListeners: emitter.listenerCount('event'),
                    heartbeatIntervals: heartbeatHandles.size, ringCount: bus.replaySince(0).length,
                    currentBusId: bus.currentSeq(), watermarkCount: bus.deliveryWatermarkCount(),
                    traceRuns: rows.traceRuns, traceEvents: rows.traceEvents, runtimeRows: rows.runtimeRows, runtimeBytes: rows.runtimeBytes,
                    dbBytes: fileBytes(appConfig.DB_PATH), walBytes: fileBytes(appConfig.DB_PATH + '-wal'),
                    pendingBatches: batch ? 1 : 0, rawReads: rawReads.size }, failure };
        }
        function send(res: Response, data: unknown, status = 200) {
            const body = JSON.stringify({ ok: true, data });
            if (Buffer.byteLength(body) > 32_768) throw Error('metrics_limit');
            res.status(status).type('json').send(body);
        }
        const deny = (res: Response, status: number, error: string) => { res.status(status).json({ ok: false, error }); };
        const equalNonce = (value: unknown) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(config.nonce)
            && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(config.nonce));
        const auth: RequestHandler = (req, res, next) => {
            const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith('wp29_probe='));
            const cookie = cookies.length === 1 ? cookies[0]!.slice('wp29_probe='.length) : undefined;
            if (stopping || req.socket.remoteAddress !== '127.0.0.1'
                || req.headers.origin !== undefined && req.headers.origin !== config.uiOrigin
                || !equalNonce(req.headers['x-wp29-probe']) && !equalNonce(cookie)) { deny(res, 403, 'probe_auth'); return; }
            next();
        };
        app.use(auth);
        app.use((req, res, next) => {
            const get = req.path === '/api/events' || req.path === '/__probe/metrics' || req.path.startsWith('/api/traces/');
            const post = ['/__probe/prepare', '/__probe/start', '/__probe/settle', '/__probe/stop'].includes(req.path);
            if (!get && !post) { deny(res, 404, 'probe_not_found'); return; }
            if (!(get && req.method === 'GET') && !(post && req.method === 'POST')) { deny(res, 405, 'probe_method'); return; }
            next();
        });
        app.use((req, res, next) => {
            res.setHeader('Cache-Control', 'no-store');
            if (req.method === 'GET' && req.path === '/api/events') {
                responses.add(res); res.once('close', () => responses.delete(res));
                const write = res.write;
                res.write = ((...args: Parameters<Response['write']>) => {
                    const result = Reflect.apply(write, res, args) as boolean;
                    writableHighWaterBytes = Math.max(writableHighWaterBytes, res.writableLength); return result;
                }) as Response['write'];
                installingSse = true; try { next(); } finally { installingSse = false; }
                return;
            }
            const captured = binding;
            const match = /^\/api\/traces\/(tr_[A-Za-z0-9_-]+)\/events\/([1-9]\d*)$/.exec(req.path);
            if (req.method === 'GET' && state === 'terminal' && match && captured && match[1] === captured.runId
                && req.query.session === captured.sessionId && Object.keys(req.query).length === 1) {
                const seq = Number(match[2]);
                res.once('finish', () => {
                    if (state === 'terminal' && binding === captured && res.statusCode === 200
                        && (seq === firstBulkTraceSeq || seq === lastTailTraceSeq)) rawReads.add(seq);
                });
            }
            next();
        });
        events.registerEventsRoutes(app, auth);
        traces.registerTraceRoutes(app, auth);
        let setup = true, switched = 0, created = 0;
        const unsubscribe = bus.subscribe(entry => {
            if (setup) {
                if (entry.topic === 'session' && entry.event === 'session_switched') switched++;
                else if (entry.topic === 'session' && entry.event === 'session_created') created++;
                else fail('unexpected_setup_publication');
                return;
            }
            if (!binding || state !== 'running' || !expectedBody || entry.topic !== 'agent' || entry.event !== 'agent_runtime'
                || entry.data.runId !== binding.runId || entry.data.turnId !== binding.turnId
                || entry.data.sessionId !== binding.sessionId || entry.data.scope !== binding.scope
                || entry.data.kind !== expectedBody.kind || (lastBusId !== null && entry.id <= lastBusId)) { fail('unexpected_publication'); return; }
            firstBusId ??= entry.id; lastBusId = entry.id; published++;
        });
        unsubscribeOnFailure = unsubscribe;
        if (bus.currentSeq() !== 0 || emitter.listenerCount('event') !== 1 || counts().traceRuns !== 0 || counts().traceEvents !== 0)
            throw Error('nonexclusive_startup');
        const { id: sessionId } = sessions.createChatSession('WP29 isolated canonical burst');
        setup = false;
        if (switched !== 1 || created !== 1 || bus.currentSeq() !== 2 || failure) throw Error('setup_event_mismatch');
        const scope = 'wp29:owned';
        const sameCycle = (cycle: BurstCycle) => binding?.cycle.phase === cycle.phase && binding.cycle.index === cycle.index;
        let sseBaseline = events.getSseMetrics();
        function runBatch() {
            batch = null;
            if (stopping || state !== 'running' || !binding || !generator) return;
            const started = performance.now();
            try {
                for (let i = 0; i < BURST_SPEC.batchSize; i++) {
                    const next = generator.next();
                    if (next.done) throw Error('generator_ended_without_terminal');
                    const body = next.value;
                    const identity = { version: 1 as const, ...binding, seq: 1 };
                    const raw = codec.encodeRuntimeBody(identity, body).raw;
                    const bytes = Buffer.byteLength(redact.stringifyTraceValue(raw), 'utf8');
                    if (bytes > codec.RUNTIME_BODY_BYTES || encodedBytes + bytes >= 4 * 1024 * 1024) throw Error('stored_byte_limit');
                    attempted++; expectedBody = body;
                    if (body.kind === 'tool') submittedOutputBytes += Buffer.byteLength(body.output!, 'utf8');
                    const event = writer.recordRuntimeEvent({ ...binding, audience: 'public' }, body);
                    expectedBody = null;
                    if (failure || !event || event.seq <= lastTraceSeq || published !== attempted) throw Error(failure ?? 'canonical_commit_or_publish_failed');
                    if (event.runId !== binding.runId || event.sessionId !== binding.sessionId || event.scope !== binding.scope || event.turnId !== binding.turnId)
                        throw Error('canonical_identity_changed');
                    if (JSON.stringify(codec.encodeRuntimeBody({ ...identity, seq: event.seq }, event).body) !== JSON.stringify(body)) throw Error('canonical_body_changed');
                    lastTraceSeq = event.seq; committed++; encodedBytes += bytes;
                    committedCanonicalBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
                    if (body.kind === 'tool' && body.itemId === 'bulk-0000') firstBulkTraceSeq = event.seq;
                    if (body.kind === 'tool' && body.itemId === 'tail-0128') lastTailTraceSeq = event.seq;
                    if (body.kind === 'turn-end') {
                        terminalTraceSeq = event.seq;
                        store.finalizeTraceRun(binding.runId, 'done', null, { onlyIfRunning: true });
                        if (store.getTraceRun(binding.runId)?.status !== 'done') throw Error('trace_finalize_failed');
                        const rows = counts();
                        if (committed !== 643 || published !== 643 || submittedOutputBytes !== 2_097_410
                            || rows.traceEvents !== 644 || rows.runtimeRows !== 643 || rows.runtimeBytes !== encodedBytes
                            || rows.storedRuntimeBytes !== encodedBytes || committedCanonicalBytes < 1_048_576) throw Error('terminal_accounting_mismatch');
                        if (firstBusId === null || lastBusId === null || lastBusId - firstBusId + 1 !== 643
                            || bus.replaySince(0).length > bus.RING_SIZE || bus.deliveryWatermarkCount() > 3)
                            throw Error('bus_resource_mismatch');
                        generator.return(undefined); generator = null;
                        state = 'terminal'; producerDurationMs = performance.now() - producerStart;
                        break;
                    }
                }
            } catch (error) { fail(error instanceof Error ? error.message : 'writer_failed'); }
            batchHighWaterMs = Math.max(batchHighWaterMs, performance.now() - started);
            if (state === 'running') batch = setImmediate(runBatch);
        }
        const bodyParser = express.json({ limit: 16_384, strict: true });
        for (const route of ['prepare', 'start', 'settle', 'stop']) app.post('/__probe/' + route, bodyParser);
        app.get('/__probe/metrics', (req, res) => {
            if (Object.keys(req.query).length) { deny(res, 400, 'invalid_metrics'); return; }
            try { send(res, metrics()); } catch { fail('metrics_observation_failed'); deny(res, 500, 'metrics_observation_failed'); }
        });
        app.post('/__probe/prepare', (req, res) => {
            if (Object.keys(req.query).length || !exact(req.body, ['cycle']) || !isBurstCycle(req.body.cycle)) { deny(res, 400, 'invalid_control'); return; }
            const expected = nextBurstCycle(previous);
            if (stopping || !['idle', 'settled'].includes(state) || !expected || expected.phase !== req.body.cycle.phase
                || expected.index !== req.body.cycle.index || events.getActiveSseConnections() !== 0) { deny(res, 409, 'cycle_order'); return; }
            try {
                if (counts().traceRuns || counts().traceEvents || emitter.listenerCount('event') !== 1 || heartbeatHandles.size) throw Error('prepare_resource_mismatch');
                const runId = store.startTraceRun({ cli: 'fixture', sessionId, scopeKey: scope, audience: 'public', workingDir: project });
                binding = { protocol: BURST_PROTOCOL, cycle: { ...req.body.cycle }, sessionId, scope, runId, turnId: runId, specId: BURST_SPEC.specId };
                attempted = committed = published = submittedOutputBytes = committedCanonicalBytes = encodedBytes = lastTraceSeq = 0;
                firstBulkTraceSeq = lastTailTraceSeq = terminalTraceSeq = firstBusId = lastBusId = null;
                producerDurationMs = batchHighWaterMs = writableHighWaterBytes = 0; rawReads.clear();
                sseBaseline = events.getSseMetrics(); state = 'prepared'; send(res, binding);
            } catch { fail('prepare_failed'); deny(res, 500, 'prepare_failed'); }
        });
        app.post('/__probe/start', (req, res) => {
            if (Object.keys(req.query).length || !exact(req.body, ['cycle']) || !isBurstCycle(req.body.cycle)) { deny(res, 400, 'invalid_control'); return; }
            if (state !== 'prepared' || !sameCycle(req.body.cycle) || events.getActiveSseConnections() !== 1) { deny(res, 409, 'start_state'); return; }
            state = 'running'; generator = burstBodies(req.body.cycle); producerStart = performance.now();
            send(res, { state }, 202); batch = setImmediate(runBatch);
        });
        app.post('/__probe/settle', (req, res) => {
            if (Object.keys(req.query).length || !exact(req.body, ['cycle', 'lastObservedTraceSeq', 'receivedCount'])
                || !isBurstCycle(req.body.cycle) || !Number.isSafeInteger(req.body.lastObservedTraceSeq)
                || !Number.isSafeInteger(req.body.receivedCount)) { deny(res, 400, 'invalid_control'); return; }
            if (state !== 'terminal' || !sameCycle(req.body.cycle) || req.body.lastObservedTraceSeq !== terminalTraceSeq
                || req.body.receivedCount !== 643 || rawReads.size !== 2 || batch || events.getActiveSseConnections() !== 0) {
                deny(res, 409, 'settle_barrier'); return;
            }
            try {
                const sse = events.getSseMetrics();
                if (emitter.listenerCount('event') !== 1 || heartbeatHandles.size || sse.slowClientClosed !== sseBaseline.slowClientClosed
                    || sse.replayGapCount !== sseBaseline.replayGapCount || sse.droppedInternalTopicEvents !== sseBaseline.droppedInternalTopicEvents)
                    throw Error('settle_resource_mismatch');
                store.finalizeTraceRun(binding!.runId, 'done', null, { onlyIfRunning: true });
                store.pruneTraceEvents(7, 0);
                if (counts().traceRuns || counts().traceEvents) throw Error('real_prune_failed');
                previous = { ...binding!.cycle }; state = 'settled'; send(res, metrics());
            } catch (error) { fail(error instanceof Error ? error.message : 'settle_failed'); deny(res, 500, failure!); }
        });
        let watchdog: NodeJS.Timeout;
        async function stop(reason: string) {
            if (stopPromise) return stopPromise;
            stopping = true; clearTimeout(watchdog);
            if (!['idle', 'settled', 'failed'].includes(state)) fail('stopped_before_settlement');
            if (batch) clearImmediate(batch); batch = null; generator?.return(undefined); generator = null;
            stopPromise = (async () => {
                let closed = false, timer: NodeJS.Timeout | undefined;
                try {
                    const httpClosed = new Promise<boolean>(resolve => server.close(error => resolve(!error)));
                    for (const res of responses) res.end(); server.closeIdleConnections();
                    closed = await Promise.race([httpClosed, new Promise<boolean>(resolve => {
                        timer = setTimeout(() => resolve(false), 5000);
                    })]);
                } finally { clearTimeout(timer); }
                // Only sockets captured from this listener are eligible, never numeric PIDs.
                if (!closed || sockets.size) {
                    const closes = [...sockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())));
                    for (const socket of sockets) socket.destroy();
                    try { await Promise.race([Promise.all(closes), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
                    finally { clearTimeout(timer); }
                }
                unsubscribe();
                const beforeClose = { activeSse: events.getActiveSseConnections(), busListeners: emitter.listenerCount('event'),
                    heartbeatIntervals: heartbeatHandles.size, sockets: sockets.size, pendingBatches: batch ? 1 : 0 };
                globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval;
                closeDb(); dbCloseNeeded = false;
                const certified = closed && !server.listening && !db.open && Object.values(beforeClose).every(value => value === 0);
                const receipt = { kind: 'stopped', protocol: BURST_PROTOCOL, pid: process.pid, reason, closed: certified,
                    httpClosed: closed, dbOpen: db.open, resources: beforeClose, failure, rootRetained: true };
                process.exitCode = certified && !failure ? 0 : 1;
                if (process.connected) await new Promise<void>(resolve => process.send!(receipt, () => resolve()));
                if (process.connected) process.disconnect?.();
                emergencyCleanup = async () => {};
            })();
            return stopPromise;
        }
        app.post('/__probe/stop', (req, res) => {
            if (Object.keys(req.query).length || !exact(req.body, [])) { deny(res, 400, 'invalid_control'); return; }
            res.once('finish', () => { void stop('http-stop'); }); send(res, { stopping: true });
        });
        app.use((_req, res) => deny(res, 404, 'probe_not_found'));
        app.use((_error: unknown, _req: Request, res: Response, _next: import('express').NextFunction) => deny(res, 400, 'invalid_control_body'));
        watchdog = setTimeout(() => { fail('watchdog'); void stop('watchdog'); }, 15 * 60_000);
        process.on('message', value => {
            if (exact(value, ['kind']) && value.kind === 'stop') void stop('ipc-stop');
            else { fail('invalid_ipc_control'); void stop('invalid-ipc'); }
        });
        process.once('disconnect', () => { if (!stopping) { fail('ipc_disconnected'); void stop('ipc-disconnected'); } });
        process.once('SIGTERM', () => { void stop('SIGTERM'); });
        process.once('SIGINT', () => { void stop('SIGINT'); });
        server.on('error', () => { fail('http_error'); void stop('http-error'); });
        const sourceFiles = ['tests/fixtures/native-activity-burst-server.mts', 'src/core/config.ts', 'src/core/db.ts',
            'src/core/chat-sessions.ts', 'src/core/bus.ts', 'src/core/event-bus.ts', 'src/core/event-scope.ts',
            'src/routes/events.ts', 'src/routes/traces.ts', 'src/agent/runtime/events.ts', 'src/trace/store.ts',
            'src/trace/runtime-body-codec.ts', 'src/trace/redact.ts', 'src/trace/activity-journal.ts',
            'src/trace/activity-control.ts', 'src/trace/activity-retention.ts', 'src/shared/runtime-contract.ts',
            'src/shared/runtime-event-parse.ts', 'src/shared/activity-state.ts', 'src/shared/activity-replay.ts',
            'public/js/features/activity-live.ts', 'public/js/features/activity-view.ts', 'public/js/event-channel.ts',
            'public/js/ui.ts', 'src/agent/spawn/process-kill.ts', 'package.json', 'package-lock.json'];
        const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
        const address = server.address();
        if (!address || typeof address === 'string') throw Error('missing_listener');
        if (process.connected) process.send!({ kind: 'ready', protocol: BURST_PROTOCOL, pid: process.pid,
            origin: `http://127.0.0.1:${address.port}`, home: jawHome, sessionId, scope, sourceHashes });
        await new Promise<void>(resolve => server.once('close', () => resolve()));
        if (stopPromise) await stopPromise;
    } finally { await emergencyCleanup(); if (dbCloseNeeded) closeDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        process.exitCode = 1;
        const failure = error instanceof Error ? error.message.slice(0, 240) : 'producer_startup_failed';
        console.error('[wp29 producer]', failure);
        if (process.connected) process.send?.({ kind: 'failed', protocol: BURST_PROTOCOL, failure }, () => {
            if (process.connected) process.disconnect?.();
        });
    });
}
