import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createManagerApiJsonParser } from '../../src/routes/code-body-parser.js';
import http, { type IncomingMessage, type Server } from 'node:http';
import {
    buildProxyUpgradeRequest,
    dashboardProxyRange,
    installDashboardProxy,
    isDashboardProxyPortAllowed,
    parseDashboardProxyUrl,
    rewriteUpstreamRequestHeaders,
    sanitizeProxyResponseHeaders,
} from '../../src/manager/proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

function listen(server: Server, port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('server did not expose a TCP address'));
                return;
            }
            resolve(address.port);
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

function requestText(
    port: number,
    path: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
            const chunks: string[] = [];
            res.setEncoding('utf8');
            res.on('data', chunk => chunks.push(String(chunk)));
            res.on('end', () => resolve({
                status: res.statusCode || 0,
                body: chunks.join(''),
                headers: res.headers,
            }));
        });
        req.on('error', reject);
    });
}

test('dashboard proxy allows only configured scan range', () => {
    const range = dashboardProxyRange({ from: 3457, count: 50 });

    assert.equal(isDashboardProxyPortAllowed(3457, range), true);
    assert.equal(isDashboardProxyPortAllowed(3506, range), true);
    assert.equal(isDashboardProxyPortAllowed(3456, range), false);
    assert.equal(isDashboardProxyPortAllowed(3507, range), false);
});

test('dashboard proxy parses safe target path', () => {
    const range = dashboardProxyRange({ from: 3457, count: 50 });
    const parsed = parseDashboardProxyUrl('/i/3457/api/health?x=1', range);

    assert.deepEqual(parsed, {
        ok: true,
        port: 3457,
        targetPath: '/api/health?x=1',
    });
});

test('dashboard proxy rejects ports outside allowlist', () => {
    const range = dashboardProxyRange({ from: 3457, count: 50 });

    assert.equal(parseDashboardProxyUrl('/i/1/', range).ok, false);
    assert.equal(parseDashboardProxyUrl('/i/65535/', range).ok, false);
    assert.equal(parseDashboardProxyUrl('/i/3507/', range).ok, false);
});

test('dashboard proxy rejects traversal paths', () => {
    const range = dashboardProxyRange({ from: 3457, count: 50 });

    assert.equal(parseDashboardProxyUrl('/i/3457/../../x', range).ok, false);
    assert.equal(parseDashboardProxyUrl('/i/3457/%2e%2e/x', range).ok, false);
    assert.equal(parseDashboardProxyUrl('/i/3457/%2E%2E/x', range).ok, false);
    assert.equal(parseDashboardProxyUrl('/i/3457/%5c..%5cx', range).ok, false);
});

test('dashboard proxy builds websocket upgrade request for target instance', () => {
    const req = {
        method: 'GET',
        httpVersion: '1.1',
        headers: {
            host: 'localhost:24576',
            connection: 'Upgrade',
            upgrade: 'websocket',
            origin: 'http://localhost:24576',
            referer: 'http://localhost:24576/manager',
        },
    } as IncomingMessage;

    const request = buildProxyUpgradeRequest(req, '/ws?client=manager', 3457);

    assert.match(request, /^GET \/ws\?client=manager HTTP\/1\.1\r\n/);
    assert.match(request, /Host: 127\.0\.0\.1:3457\r\n/);
    assert.match(request, /connection: Upgrade\r\n/);
    assert.match(request, /upgrade: websocket\r\n/);
    assert.match(request, /origin: http:\/\/127\.0\.0\.1:3457\r\n/);
    assert.match(request, /referer: http:\/\/127\.0\.0\.1:3457\/manager\r\n/);
});

test('dashboard proxy response headers strip frame policy and rewrite absolute location', () => {
    const headers = sanitizeProxyResponseHeaders({
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
        location: 'http://127.0.0.1:3457/next',
    }, {
        targetOrigin: 'http://127.0.0.1:3457',
        publicBase: '/i/3457',
    });

    assert.equal(headers['x-frame-options'], undefined);
    assert.equal(headers['content-security-policy'], undefined);
    assert.equal(headers.location, '/i/3457/next');
});

test('dashboard proxy leaves relative location unchanged', () => {
    const headers = sanitizeProxyResponseHeaders({ location: '/next' }, {
        targetOrigin: 'http://127.0.0.1:3457',
        publicBase: '/i/3457',
    });

    assert.equal(headers.location, '/next');
});

test('dashboard proxy rewrites upstream headers without synthesizing origin or referer', () => {
    assert.deepEqual(rewriteUpstreamRequestHeaders({ host: 'localhost:24576' }, 3457), {
        host: '127.0.0.1:3457',
    });

    const headers = rewriteUpstreamRequestHeaders({
        host: 'localhost:24576',
        origin: 'http://localhost:24576',
        referer: 'http://localhost:24576/manager',
    }, 3457);

    assert.equal(headers.host, '127.0.0.1:3457');
    assert.equal(headers.origin, 'http://127.0.0.1:3457');
    assert.equal(headers.referer, 'http://127.0.0.1:3457/manager');
});

test('dashboard proxy exposes websocket upgrade routing contract', () => {
    const proxy = read('src/manager/proxy.ts');

    assert.ok(proxy.includes("server.on('upgrade'"));
    assert.ok(proxy.includes("if (!req.url?.startsWith('/i/')) return"));
    assert.ok(proxy.includes('proxyWebSocketUpgrade'));
    assert.ok(proxy.includes('parseDashboardProxyUrl'));
    assert.ok(proxy.includes('buildProxyUpgradeRequest'));
});

test('manager production parser and legacy proxy preserve small and large raw JSON bodies', async () => {
    const received: Array<{ method: string | undefined; url: string | undefined;
        contentType: string | undefined; transferEncoding: string | undefined; body: Buffer }> = [];
    const target = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('error', () => res.destroy());
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            received.push({ method: req.method, url: req.url, contentType: req.headers['content-type'],
                transferEncoding: req.headers['transfer-encoding'], body });
            res.writeHead(201, { 'content-type': 'application/octet-stream' });
            res.end(body);
        });
    });
    const app = express();
    app.use(createManagerApiJsonParser());
    const manager = http.createServer(app);
    try {
        const targetPort = await listen(target);
        installDashboardProxy(app, manager, { from: targetPort, count: 1 });
        const managerPort = await listen(manager);
        const targetPath = '/api/message?source=parser-regression';
        const bodies = [
            // Whitespace and a raw JSON escape expose unwanted parse/reserialization.
            Buffer.from(String.raw` { "text": "\u0061", "number": 1 } ` + '\n'),
            Buffer.from(JSON.stringify({ text: '가'.repeat(24_000), request: 'large' }, null, 2) + '\n'),
        ];
        assert.ok(bodies[0]!.length < 65_536);
        assert.ok(bodies[1]!.length > 65_536, 'large body must exceed the ordinary Manager JSON limit');
        for (const [index, body] of bodies.entries()) {
            const response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port: managerPort,
                    path: `/i/${targetPort}${targetPath}`, method: 'POST',
                    // Small input has a length; large input exercises chunked forwarding.
                    headers: { 'content-type': 'application/json',
                        ...(index === 0 ? { 'content-length': String(body.length) } : {}) },
                    signal: AbortSignal.timeout(10_000),
                }, res => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('error', reject);
                    res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
                });
                req.on('error', reject);
                req.write(body.subarray(0, 13));
                req.write(body.subarray(13, 50_000));
                req.end(body.subarray(50_000));
            });
            assert.equal(response.status, 201, `body ${index}: response must come from the worker`);
            assert.deepEqual(response.body, body, `body ${index}: worker echo must remain byte-exact`);
            assert.equal(received.length, index + 1, 'each request reaches the worker exactly once');
            assert.deepEqual(received[index], { method: 'POST', url: targetPath,
                contentType: 'application/json', transferEncoding: index === 0 ? undefined : 'chunked', body });
        }
    } finally {
        // A parser regression can strand the upstream request; failure cleanup must not hang.
        manager.closeAllConnections();
        target.closeAllConnections();
        await Promise.all([closeServer(manager), closeServer(target)]);
    }
});

test('legacy dashboard proxy injects external-link escape policy into HTML responses', async () => {
    const target = http.createServer((_req, res) => {
        const body = '<!doctype html><html><head><title>x</title></head><body><a href="https://example.com">External</a></body></html>';
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(Buffer.byteLength(body)),
            'content-security-policy': "frame-ancestors 'none'",
        });
        res.end(body);
    });
    const targetPort = await listen(target);
    const app = express();
    const manager = http.createServer(app);
    installDashboardProxy(app, manager, { from: targetPort, count: 1 });
    const managerPort = await listen(manager);

    try {
        const response = await requestText(managerPort, `/i/${targetPort}/links`);

        assert.equal(response.status, 200);
        assert.match(response.body, /data-jaw-preview-link-policy/);
        assert.match(response.body, /window\.open/);
        assert.equal(response.headers['content-security-policy'], undefined);
        assert.equal(response.headers['content-length'], undefined);
    } finally {
        await closeServer(manager);
        await closeServer(target);
    }
});
