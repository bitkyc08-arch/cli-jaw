import type { Express, Request, Response } from 'express';
import type { IncomingMessage, Server } from 'node:http';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import {
    MANAGED_INSTANCE_HOST,
    MANAGED_INSTANCE_PORT_COUNT,
    MANAGED_INSTANCE_PORT_FROM,
} from './constants.js';
import {
    injectPreviewLinkPolicy,
    MAX_INJECT_BUFFER_CHARS,
    preferIdentityEncoding,
    prepareInjectedPreviewHeaders,
    shouldInjectPreviewLinkPolicy,
} from './preview-link-policy.js';

export type DashboardProxyOptions = {
    from?: number;
    count?: number;
};

export type ProxyPortRange = {
    from: number;
    to: number;
};

export type ProxyHeaderRewriteOptions = {
    targetOrigin: string;
    publicBase: string;
};

type ParsedProxyUrl = {
    ok: true;
    port: number;
    targetPath: string;
} | {
    ok: false;
    status: number;
    reason: string;
};

function positiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function targetOriginForPort(port: number): string {
    return `http://${MANAGED_INSTANCE_HOST}:${port}`;
}

export function dashboardProxyRange(options: DashboardProxyOptions = {}): ProxyPortRange {
    const from = positiveInt(options.from, MANAGED_INSTANCE_PORT_FROM);
    const count = positiveInt(options.count, MANAGED_INSTANCE_PORT_COUNT);
    return { from, to: from + Math.max(1, count) - 1 };
}

export function isDashboardProxyPortAllowed(port: number, range: ProxyPortRange): boolean {
    return Number.isInteger(port) && port >= range.from && port <= range.to;
}

function safeDecodePath(path: string): string | null {
    try {
        return decodeURIComponent(path);
    } catch {
        return null;
    }
}

export function isUnsafeProxyPath(targetPath: string): boolean {
    if (!targetPath.startsWith('/')) return true;
    if (/%2f/i.test(targetPath) || /%5c/i.test(targetPath)) return true;

    const decoded = safeDecodePath(targetPath);
    if (!decoded) return true;
    if (decoded.includes('\\')) return true;

    const pathname = decoded.split(/[?#]/, 1)[0] || '/';
    return pathname.split('/').some(segment => segment === '..');
}

export function parseDashboardProxyUrl(originalUrl: string, range: ProxyPortRange): ParsedProxyUrl {
    const match = originalUrl.match(/^\/i\/(\d+)(\/.*)?$/);
    if (!match) return { ok: false, status: 404, reason: 'proxy route not found' };

    const port = Number(match[1]);
    if (!isDashboardProxyPortAllowed(port, range)) {
        return { ok: false, status: 403, reason: 'proxy port is outside the allowed dashboard range' };
    }

    const targetPath = match[2] || '/';
    if (isUnsafeProxyPath(targetPath)) {
        return { ok: false, status: 400, reason: 'unsafe proxy path' };
    }

    return { ok: true, port, targetPath };
}

export function rewriteAbsoluteLocationHeader(value: string, options: ProxyHeaderRewriteOptions): string {
    return value.startsWith(options.targetOrigin)
        ? `${options.publicBase}${value.slice(options.targetOrigin.length)}`
        : value;
}

export function sanitizeProxyResponseHeaders(
    headers: http.IncomingHttpHeaders,
    options: ProxyHeaderRewriteOptions,
): http.OutgoingHttpHeaders {
    const next: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'x-frame-options' || lower === 'content-security-policy') continue;
        if (lower === 'location' && typeof value === 'string') {
            next[key] = rewriteAbsoluteLocationHeader(value, options);
            continue;
        }
        next[key] = value;
    }
    return next;
}

function rewriteHeaderUrl(value: string, targetPort: number): string {
    try {
        const parsed = new URL(value);
        parsed.protocol = 'http:';
        parsed.hostname = MANAGED_INSTANCE_HOST;
        parsed.port = String(targetPort);
        return parsed.toString();
    } catch {
        return targetOriginForPort(targetPort);
    }
}

export function rewriteUpstreamRequestHeaders(
    headers: IncomingMessage['headers'],
    targetPort: number,
): http.OutgoingHttpHeaders {
    const next: http.OutgoingHttpHeaders = { ...headers };
    next.host = `${MANAGED_INSTANCE_HOST}:${targetPort}`;
    if (headers.origin) {
        next.origin = Array.isArray(headers.origin)
            ? headers.origin.map(() => targetOriginForPort(targetPort)).join(', ')
            : targetOriginForPort(targetPort);
    } else {
        delete next.origin;
    }
    if (headers.referer) {
        next.referer = Array.isArray(headers.referer)
            ? headers.referer.map(value => rewriteHeaderUrl(value, targetPort)).join(', ')
            : rewriteHeaderUrl(headers.referer, targetPort);
    } else {
        delete next.referer;
    }
    return next;
}

function proxyHttpRequest(req: Request, res: Response, range: ProxyPortRange): void {
    const parsed = parseDashboardProxyUrl(req.originalUrl, range);
    if (!parsed.ok) {
        res.status(parsed.status).json({ ok: false, error: parsed.reason });
        return;
    }

    const upstream = http.request({
        hostname: MANAGED_INSTANCE_HOST,
        port: parsed.port,
        method: req.method,
        path: parsed.targetPath,
        headers: preferIdentityEncoding(rewriteUpstreamRequestHeaders(req.headers, parsed.port)),
    }, (upstreamRes) => {
        const headers = sanitizeProxyResponseHeaders(upstreamRes.headers, {
            targetOrigin: targetOriginForPort(parsed.port),
            publicBase: `/i/${parsed.port}`,
        });
        if (shouldInjectPreviewLinkPolicy(req.method, upstreamRes.statusCode, upstreamRes.headers)) {
            const chunks: string[] = [];
            let buffered = 0;
            let bailed = false;
            upstreamRes.setEncoding('utf8');
            upstreamRes.on('data', chunk => {
                const text = String(chunk);
                if (bailed) {
                    if (!res.writableEnded && !res.destroyed) res.write(text);
                    return;
                }
                chunks.push(text);
                buffered += text.length;
                if (buffered > MAX_INJECT_BUFFER_CHARS) {
                    // Past the cap, injection would buffer unboundedly —
                    // flush and stream the rest uninjected.
                    bailed = true;
                    delete headers['content-length'];
                    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, headers);
                    res.write(chunks.join(''));
                    chunks.length = 0;
                }
            });
            upstreamRes.on('end', () => {
                if (bailed) {
                    res.end();
                    return;
                }
                res.writeHead(
                    upstreamRes.statusCode || 502,
                    upstreamRes.statusMessage,
                    prepareInjectedPreviewHeaders(headers),
                );
                res.end(injectPreviewLinkPolicy(chunks.join('')));
            });
            return;
        }
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, headers);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (error: Error) => {
        if (!res.headersSent) {
            res.status(502).json({ ok: false, error: error.message });
            return;
        }
        res.end();
    });

    req.pipe(upstream);
}

function destroyQuietly(stream: Duplex): void {
    if (!stream.destroyed) stream.destroy();
}

function writeThenDestroy(socket: Duplex, data: string): void {
    if (socket.destroyed) return;
    try {
        socket.write(data, () => destroyQuietly(socket));
    } catch {
        destroyQuietly(socket);
    }
}

export function buildProxyUpgradeRequest(req: IncomingMessage, targetPath: string, targetPort: number): string {
    const lines = [`${req.method || 'GET'} ${targetPath} HTTP/${req.httpVersion}`];
    const headers = rewriteUpstreamRequestHeaders(req.headers, targetPort);
    for (const [key, value] of Object.entries(headers)) {
        if (value == null) continue;
        const headerValue = Array.isArray(value) ? value.join(', ') : value;
        const headerName = key.toLowerCase() === 'host' ? 'Host' : key;
        lines.push(`${headerName}: ${headerValue}`);
    }
    lines.push('', '');
    return lines.join('\r\n');
}

function proxyWebSocketUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, range: ProxyPortRange): void {
    const parsed = parseDashboardProxyUrl(req.url || '', range);
    if (!parsed.ok) {
        writeThenDestroy(socket, `HTTP/1.1 ${parsed.status} ${parsed.reason}\r\nConnection: close\r\n\r\n`);
        return;
    }

    const upstream = net.connect(parsed.port, MANAGED_INSTANCE_HOST, () => {
        upstream.write(buildProxyUpgradeRequest(req, parsed.targetPath, parsed.port));
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
    });

    socket.on('error', () => {
        destroyQuietly(upstream);
    });
    socket.on('close', () => {
        destroyQuietly(upstream);
    });
    upstream.on('close', () => {
        destroyQuietly(socket);
    });
    upstream.on('error', () => {
        writeThenDestroy(socket, 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
}

export function installDashboardProxy(app: Express, server: Server, options: DashboardProxyOptions = {}): void {
    const range = dashboardProxyRange(options);

    app.use('/i/:port', (req: Request, res: Response) => {
        proxyHttpRequest(req, res, range);
    });

    server.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/i/')) return;
        proxyWebSocketUpgrade(req, socket, head, range);
    });
}
