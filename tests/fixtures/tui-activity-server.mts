/** Loopback fixture for the real CLI/PTY smoke. Never loaded by the server. */
import { createServer, type ServerResponse } from 'node:http';
import type { RuntimeEvent } from '../../src/shared/runtime-contract.js';

const clients = new Set<ServerResponse>();
const identity = { sessionId: 'tui-pty-chat', scope: 'local:tui-pty-chat' };
const requests: Array<{ path: string; body: unknown }> = [];
const events: RuntimeEvent[] = [];
let serial = 0;
let presentation = 'activity';
const emit = (value: Record<string, unknown>) => {
    const { type, ...body } = value;
    if (type === 'agent_runtime') events.push(body as RuntimeEvent);
    for (const client of clients) client.write(`id: ${++serial}\ndata: ${JSON.stringify({ event: type, topic: 'agent', ...body })}\n\n`);
};
const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
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
    else if (url.pathname === '/api/orchestrate/snapshot') json({ ok: true, data: { activityIdentity: identity, queue: [] } });
    else if (url.pathname === '/api/message' || url.pathname === '/api/stop') {
        requests.push({ path: url.pathname, body });
        json({ ok: true });
    } else if (url.pathname === '/fixture/state') json({ requests, clients: clients.size, events: events.length });
    else if (url.pathname === '/fixture/event' && req.method === 'POST') {
        emit(body as Record<string, unknown>); json({ ok: true });
    } else if (url.pathname === '/fixture/disconnect' && req.method === 'POST') {
        for (const client of clients) client.end();
        clients.clear(); json({ ok: true });
    } else if (url.pathname === '/api/runtime/requests') json({ ok: true, data: { requests: [] } });
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
