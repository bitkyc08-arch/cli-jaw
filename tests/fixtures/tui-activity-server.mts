/** Deterministic client fixture, NOT the production journal/persistence server.
 * Control is in-process only: no HTTP endpoint can inject events or run commands.
 */
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export const LIMITS = Object.freeze({ activeMs: 150_000, wholeMs: 180_000, readyMs: 10_000,
    httpMs: 2000, streamBytes: 8 * 1024 * 1024, journalBytes: 4 * 1024 * 1024,
    events: 4096, logRows: 4096, bodyBytes: 1024 * 1024, frameBytes: 128 * 1024 });
export const OWNER = Object.freeze({ sessionId: 'pty-fixture-chat', scope: 'local:pty-fixture-chat' });
export const RUN_A = 'tr_pty_fixture_run_A000';
export const RUN_B = 'tr_pty_fixture_run_B000';
type Wire = Record<string, unknown>;
type Run = { id: string; scope: string; events: Wire[]; status: 'running' | 'done' | 'interrupted'; startedAt: number };
type Saved = { id: number; role: 'assistant'; content: string; trace_run_id: string; session_id: string };
type RequestRow = { method: string; path: string; status: number; body: unknown; activeRun: string | null };

export async function createActivityFixture(workingDir: string) {
    const runs = new Map<string, Run>();
    const saved = new Map<string, Saved>(); // Deliberately independent of event/finality emission.
    const clients = new Set<ServerResponse>();
    const sockets = new Set<Socket>();
    const requests: RequestRow[] = [];
    const errors: string[] = [];
    let connections = 0, serial = 0, eventCount = 0, journalBytes = 0, wireBytes = 0, logBytes = 0;
    let activeRun: string | null = null;
    function fail(error: unknown) {
        if (errors.length < 16) errors.push(String(error).slice(0, 2048));
    }
    function log(row: RequestRow) {
        const size = Buffer.byteLength(JSON.stringify(row));
        if (requests.length >= LIMITS.logRows || logBytes + size > LIMITS.streamBytes) throw Error('fixture request log limit');
        logBytes += size; requests.push(row);
    }
    function cursor(url: URL, key: string, fallback: number) {
        const value = url.searchParams.get(key);
        if (value === null) return fallback;
        if (!/^\d{1,9}$/.test(value)) throw Error(`invalid ${key}`);
        return Number(value);
    }
    const server = createServer(async (req, res) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = req.method ?? '';
        let body: unknown = null;
        const reply = (status: number, value: unknown) => {
            log({ method, path: url.pathname + url.search, status, body, activeRun });
            const bytes = Buffer.from(JSON.stringify(value));
            wireBytes += bytes.length;
            if (wireBytes > LIMITS.streamBytes) throw Error('fixture HTTP/SSE byte limit');
            res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length }); res.end(bytes);
        };
        try {
            if ((req.url?.length ?? 0) > 2048) throw Error('URL limit');
            timer = setTimeout(() => { fail('fixture request exceeded 2s'); res.destroy(); }, LIMITS.httpMs);
            const chunks: Buffer[] = []; let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > LIMITS.bodyBytes) throw Error('fixture body limit');
                chunks.push(Buffer.from(chunk));
            }
            if (bytes) body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            if (method === 'GET' && url.pathname === '/api/events' && !url.search) {
                log({ method, path: url.pathname, status: 200, body, activeRun });
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(': fixture ready\n\n'); clients.add(res); connections++;
                res.on('close', () => clients.delete(res)); return;
            }
            if (method === 'GET' && url.pathname === '/api/auth/token') return reply(200, { token: '' });
            if (method === 'GET' && url.pathname === '/api/settings') return reply(200, { ok: true, data: {
                cli: 'codex-app', workingDir, locale: 'en', perCli: { 'codex-app': { model: 'PTY fixture' } },
                tui: { fullscreen: true }, presentation: { mode: 'activity' },
            } });
            if (method === 'GET' && url.pathname === '/api/session') return reply(200, { ok: true, data: { model: 'PTY fixture' } });
            if (method === 'GET' && url.pathname === '/api/orchestrate/snapshot') return reply(200, { ok: true, data: {
                activityIdentity: OWNER, queue: [], activeRun: activeRun ? { traceRunId: activeRun } : null,
            } });
            if (method === 'POST' && url.pathname === '/api/message') {
                if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'prompt'
                    || typeof Reflect.get(body, 'prompt') !== 'string') return reply(400, { ok: false, error: 'invalid_prompt' });
                return reply(200, { ok: true });
            }
            if (method === 'POST' && url.pathname === '/api/stop' && body === null) return reply(200, { ok: true });
            const messageMatch = /^\/api\/messages\/by-trace\/(tr_[A-Za-z0-9_-]+)$/.exec(url.pathname);
            const activityMatch = /^\/api\/traces\/(tr_[A-Za-z0-9_-]+)\/activity$/.exec(url.pathname);
            const discovery = url.pathname === '/api/traces/activity-runs';
            if (method === 'GET' && (messageMatch || activityMatch || discovery)) {
                if (url.searchParams.get('session') !== OWNER.sessionId) return reply(404, { ok: false, error: 'owner_denied' });
                const allowed = messageMatch ? ['session'] : discovery ? ['session', 'after'] : ['session', 'after', 'through', 'limit'];
                const keys = [...url.searchParams.keys()];
                if (new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) return reply(400, { ok: false, error: 'invalid_query' });
                if (messageMatch) return reply(200, { ok: true, data: { message: saved.get(messageMatch[1]!) ?? null } });
                if (discovery) return reply(200, { ok: true, data: { pageSize: 40, runs: [...runs.values()]
                    .sort((a, b) => a.id.localeCompare(b.id)).filter(run => run.id > (url.searchParams.get('after') ?? '')).slice(0, 40)
                    .map(run => ({ id: run.id, messageId: saved.get(run.id)?.id ?? null, startedAt: run.startedAt, status: run.status })) } });
                const run = runs.get(activityMatch![1]!);
                if (!run) return reply(404, { ok: false, error: 'unknown_run' });
                const through = cursor(url, 'through', Number(run.events.at(-1)?.seq ?? 0));
                const after = cursor(url, 'after', 0);
                const limit = cursor(url, 'limit', 40);
                if (limit < 1 || limit > 40 || through < after) return reply(400, { ok: false, error: 'invalid_page' });
                const selected = run.events.filter(event => Number(event.seq) > after && Number(event.seq) <= through);
                const page = selected.slice(0, limit);
                return reply(200, { ok: true, data: { runId: run.id, sessionId: OWNER.sessionId, scope: run.scope,
                    events: page, through, nextAfter: page.at(-1)?.seq ?? through, hasMore: selected.length > limit,
                    incomplete: false, loss: null, status: run.status } });
            }
            // A missing route must fail visibly, even when the client tolerates it.
            return reply(404, { ok: false, error: 'unexpected_fixture_route' });
        } catch (error) {
            fail(error);
            if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'fixture_request_failed' }));
        } finally { clearTimeout(timer); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('error', fail);
    server.requestTimeout = LIMITS.httpMs; server.headersTimeout = LIMITS.httpMs;
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('fixture did not retain loopback socket');
    function emit(packet: Wire) {
        const { type, ...rest } = packet;
        const frame = `id: ${++serial}\ndata: ${JSON.stringify({ event: type, topic: 'agent', ...rest })}\n\n`;
        wireBytes += Buffer.byteLength(frame) * clients.size;
        if (serial > LIMITS.events || wireBytes > LIMITS.streamBytes) throw Error('fixture SSE limit');
        for (const client of clients) {
            if (client.writableLength + Buffer.byteLength(frame) > LIMITS.bodyBytes) throw Error('fixture slow SSE client');
            client.write(frame);
        }
    }
    return {
        port: address.port, requests, errors,
        get connections() { return connections; },
        get activeRun() { return activeRun; },
        get clientCount() { return clients.size; },
        emit,
        event(runId: string, seq: number, kind: string, fields: Wire = {}, publish = true) {
            if (![RUN_A, RUN_B].includes(runId) || !Number.isSafeInteger(seq) || seq <= 0) throw Error('fixture event identity');
            let run = runs.get(runId);
            if (!run) {
                if (kind !== 'turn-start') throw Error('fixture missing start');
                run = { id: runId, scope: OWNER.scope, events: [], status: 'running', startedAt: runs.size + 1 };
                runs.set(runId, run);
            }
            if (seq <= Number(run.events.at(-1)?.seq ?? 0)) throw Error('fixture event ordering');
            const event = { ...fields, version: 1, ...OWNER, runId, turnId: `turn-${runId}`, seq, kind };
            const bytes = Buffer.byteLength(JSON.stringify(event));
            if (eventCount + 1 > LIMITS.events || journalBytes + bytes > LIMITS.journalBytes) throw Error('fixture journal limit');
            eventCount++; journalBytes += bytes; run.events.push(event);
            if (kind === 'turn-start') activeRun = runId;
            if (kind === 'turn-end') { run.status = fields.status === 'stopped' ? 'interrupted' : 'done'; if (activeRun === runId) activeRun = null; }
            if (publish) emit({ type: 'agent_runtime', ...event });
        },
        save(runId: string, content: string | null) {
            if (!runs.has(runId)) throw Error('save for unknown run');
            if (content === null) { saved.delete(runId); return; }
            if (Buffer.byteLength(content) > LIMITS.bodyBytes) throw Error('fixture saved answer limit');
            saved.set(runId, { id: runId === RUN_A ? 101 : 102, role: 'assistant', content, trace_run_id: runId, session_id: OWNER.sessionId });
        },
        disconnect() { for (const client of clients) client.end(); clients.clear(); },
        state() { return { connections, activeRun, eventCount, journalBytes, wireBytes, logBytes, requests, errors,
            runs: [...runs.values()], saved: [...saved.values()] }; },
        async close() {
            for (const client of clients) client.end();
            const closed = new Promise<void>(resolve => server.close(() => resolve()));
            for (const socket of sockets) socket.destroy();
            await closed;
            return { listening: server.listening, sockets: sockets.size, clients: clients.size };
        },
    };
}
