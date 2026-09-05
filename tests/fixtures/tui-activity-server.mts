/** Loopback fixture for the real CLI/PTY smoke. Never loaded by the server. */
import { createServer, type ServerResponse } from 'node:http';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';

const clients = new Set<ServerResponse>();
const identity = { sessionId: 'tui-pty-chat', scope: 'local:tui-pty-chat' };
const requests: Array<{ path: string; body: unknown }> = [];
const reads: string[] = [];
const events: RuntimeEvent[] = [];
let serial = 0;
let presentation = 'activity';
let connections = 0;
const emit = (value: Record<string, unknown>) => {
    const { type, ...body } = value;
    if (type === 'agent_runtime' && !events.some(event => event.runId === body['runId'] && event.seq === body['seq'])) events.push(body as RuntimeEvent);
    for (const client of clients) client.write(`id: ${++serial}\ndata: ${JSON.stringify({ event: type, topic: 'agent', ...body })}\n\n`);
};
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) reads.push(url.pathname + url.search);
    let body: unknown;
    try {
        let text = '';
        for await (const chunk of req) {
            text += chunk;
            if (text.length > 1_000_000) throw new Error('fixture request too large');
        }
        body = text ? JSON.parse(text) : {};
    } catch { res.writeHead(400).end(); return; }
    const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
    };
    if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        connections++;
        req.on('close', () => clients.delete(res));
    } else if (url.pathname === '/api/auth/token') json({ token: '' });
    else if (url.pathname === '/api/settings') {
        if (req.method === 'PUT') {
            const patch = body as { presentation?: { mode?: string } };
            if (patch.presentation?.mode) presentation = patch.presentation.mode;
        }
        json({ ok: true, data: { cli: 'codex-app', workingDir: '/tmp/tui-fixture', locale: 'en',
            perCli: { 'codex-app': { model: 'fixture' } }, tui: { fullscreen: true }, presentation: { mode: presentation } } });
    } else if (url.pathname === '/api/session') json({ ok: true, data: { model: 'fixture' } });
    else if (url.pathname === '/api/orchestrate/snapshot') json({ ok: true, data: { activityIdentity: identity, queue: [], activeRun: null } });
    else if (url.pathname === '/api/message' || url.pathname === '/api/stop') {
        requests.push({ path: url.pathname, body });
        json({ ok: true });
    } else if (url.pathname === '/fixture/state') json({ requests, clients: clients.size, events: events.length, reads, connections });
    else if (url.pathname === '/fixture/event' && req.method === 'POST') {
        emit(body as Record<string, unknown>); json({ ok: true });
    } else if (url.pathname === '/fixture/disconnect' && req.method === 'POST') {
        for (const client of clients) client.end();
        clients.clear(); json({ ok: true });
    } else if (url.pathname === '/api/runtime/requests') json({ ok: true, data: { requests: [] } });
    else if (url.pathname === '/api/traces/activity-runs') {
        const ids = [...new Set(events.map(event => event.runId))].sort().filter(id => id > (url.searchParams.get('after') ?? ''));
        const runs = ids.slice(0, 40).map((id, index) => {
            const end = events.find(event => event.runId === id && event.kind === 'turn-end');
            return { id, messageId: null, startedAt: 1000 + index,
                status: end?.kind === 'turn-end' ? end.status === 'stopped' ? 'interrupted' : end.status : 'running' };
        });
        json({ ok: true, data: { runs, pageSize: 40 } });
    } else if (/^\/api\/traces\/[^/]+\/activity$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[3]!);
        const all = events.filter(event => event.runId === id).sort((a, b) => a.seq - b.seq);
        const through = Number(url.searchParams.get('through') ?? all.at(-1)?.seq ?? 0);
        const selected = all.filter(event => event.seq > Number(url.searchParams.get('after') ?? 0) && event.seq <= through);
        const chunk = selected.slice(0, 40);
        const end = all.find(event => event.kind === 'turn-end');
        json({ ok: true, data: { runId: id, ...identity, events: chunk, through,
            nextAfter: chunk.at(-1)?.seq ?? through, hasMore: selected.length > chunk.length,
            status: end?.kind === 'turn-end' ? end.status === 'stopped' ? 'interrupted' : end.status : 'running',
            incomplete: false, loss: null } });
    }
    else { res.writeHead(404).end(JSON.stringify({ error: 'fixture_route_not_defined' })); }
});
server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    console.log(JSON.stringify({ port: typeof address === 'object' && address ? address.port : 0 }));
});
const stop = () => {
    for (const client of clients) client.end();
    server.closeAllConnections();
    server.close(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
setTimeout(stop, 180_000).unref();
