import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import express, { type RequestHandler } from 'express';
import { registerStaticRoutes } from '../../src/routes/static.ts';
import { settings } from '../../src/core/config.ts';
import { errorHandler } from '../../src/http/error-middleware.ts';

const MIME_CASES = new Map([
    ['image.png', 'image/png'],
    ['image.jpg', 'image/jpeg'],
    ['image.jpeg', 'image/jpeg'],
    ['image.gif', 'image/gif'],
    ['image.webp', 'image/webp'],
    ['video.mp4', 'video/mp4'],
    ['video.webm', 'video/webm'],
    ['video.mov', 'video/quicktime'],
    ['video.ogg', 'video/ogg'],
]);

async function withServer(run: (baseUrl: string, authCalls: () => number) => Promise<void>): Promise<void> {
    const app = express();
    let calls = 0;
    const requireAuth: RequestHandler = (_req, _res, next) => {
        calls += 1;
        next();
    };
    registerStaticRoutes(app, requireAuth, { projectRoot: path.resolve(import.meta.dirname, '../..') });
    app.use(errorHandler);
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        await run(`http://127.0.0.1:${address.port}`, () => calls);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

test('GET /api/image enforces roots, media types, headers, and status mapping', async () => {
    const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-image-allowed-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-image-outside-'));
    const previousWorkingDir = settings['workingDir'];
    const previousProjectDirs = settings['projectDirs'];
    try {
        for (const name of MIME_CASES.keys()) fs.writeFileSync(path.join(allowedDir, name), name);
        fs.writeFileSync(path.join(allowedDir, 'active.svg'), '<svg></svg>');
        fs.mkdirSync(path.join(allowedDir, 'directory.png'));

        const outsideImagePath = path.join(outsideDir, 'outside.png');
        fs.writeFileSync(outsideImagePath, 'blocked');
        const escapingSymlinkPath = path.join(allowedDir, 'escape.png');
        fs.symlinkSync(outsideImagePath, escapingSymlinkPath);

        const deniedExtensionlessPath = path.join(outsideDir, 'hosts');
        fs.writeFileSync(deniedExtensionlessPath, 'blocked');

        settings['workingDir'] = allowedDir;
        settings['projectDirs'] = null;

        await withServer(async (baseUrl, authCalls) => {
            for (const [name, contentType] of MIME_CASES) {
                const filePath = path.join(allowedDir, name);
                const res = await fetch(`${baseUrl}/api/image?path=${encodeURIComponent(filePath)}`);
                assert.equal(res.status, 200, name);
                assert.match(res.headers.get('content-type') || '', new RegExp(`^${contentType}`));
                assert.equal(res.headers.get('cache-control'), 'no-store');
                assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
                assert.equal(Buffer.from(await res.arrayBuffer()).toString(), name);
            }

            const missingQuery = await fetch(`${baseUrl}/api/image`);
            assert.equal(missingQuery.status, 400);
            const repeatedQuery = await fetch(`${baseUrl}/api/image?path=a.png&path=b.png`);
            assert.equal(repeatedQuery.status, 400);
            const malformed = await fetch(`${baseUrl}/api/image?path=relative.png`);
            assert.equal(malformed.status, 400);
            const nulPath = await fetch(`${baseUrl}/api/image?path=${encodeURIComponent('/tmp/a\0.png')}`);
            assert.equal(nulPath.status, 400);

            const escaped = await fetch(`${baseUrl}/api/image?path=${encodeURIComponent(escapingSymlinkPath)}`);
            assert.equal(escaped.status, 403);
            const guardBeforeExtension = await fetch(`${baseUrl}/api/image?path=${encodeURIComponent(deniedExtensionlessPath)}`);
            assert.equal(guardBeforeExtension.status, 403);

            const missing = await fetch(`${baseUrl}/api/image?path=${encodeURIComponent(path.join(allowedDir, 'missing.png'))}`);
            assert.equal(missing.status, 404);
            const directory = await fetch(`${baseUrl}/api/image?path=${encodeURIComponent(path.join(allowedDir, 'directory.png'))}`);
            assert.equal(directory.status, 404);
            const svg = await fetch(`${baseUrl}/api/image?path=${encodeURIComponent(path.join(allowedDir, 'active.svg'))}`);
            assert.equal(svg.status, 400);

            assert.equal(authCalls(), MIME_CASES.size + 9);
        });
    } finally {
        settings['workingDir'] = previousWorkingDir;
        settings['projectDirs'] = previousProjectDirs;
        fs.rmSync(allowedDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    }
});
