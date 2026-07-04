/**
 * 186 Phase 3 -- /api/dashboard/design routes.
 *
 * Drives the real express Router with fake req/res:
 * - status codes for list/create/get/patch/write/preview
 * - mutating routes require the desktop identity header (403 otherwise)
 * - 409 conflict surfaces for stale baseRevision
 * - preview responds with HTML + locked CSP (script-src 'none')
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['CLI_JAW_DASHBOARD_HOME'] = mkdtempSync(join(tmpdir(), 'jaw-design-routes-'));

const { createDashboardDesignRouter } = await import('../../src/manager/routes/dashboard-design.js');
const router = createDashboardDesignRouter();

type FakeResult = { code: number; body: unknown; headers: Record<string, string>; raw: string | null };

function request(method: string, url: string, options: { body?: unknown; desktop?: boolean } = {}): Promise<FakeResult> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (options.desktop) headers['x-cli-jaw-electron'] = '1';
        const req = {
            method,
            url,
            originalUrl: url,
            baseUrl: '',
            headers,
            query: Object.fromEntries(new URL(url, 'http://local').searchParams.entries()),
            body: options.body,
            get(name: string) { return headers[name.toLowerCase()]; },
        };
        const out: FakeResult = { code: 200, body: null, headers: {}, raw: null };
        const res = {
            statusCode: 200,
            status(code: number) { out.code = code; return this; },
            setHeader(name: string, value: string) { out.headers[name.toLowerCase()] = value; },
            getHeader(name: string) { return out.headers[name.toLowerCase()]; },
            json(value: unknown) { out.body = value; resolve(out); },
            send(value: string) { out.raw = value; resolve(out); },
            end() { resolve(out); },
        };
        (router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void)(
            req,
            res,
            (err?: unknown) => (err ? reject(err) : resolve({ ...out, code: 404, body: { ok: false, error: 'unmatched route' } })),
        );
    });
}

test('list starts empty and create requires the desktop header', async () => {
    const empty = await request('GET', '/pages');
    assert.equal(empty.code, 200);
    assert.deepEqual((empty.body as { pages: unknown[] }).pages, []);

    const forbidden = await request('POST', '/pages', { body: { title: 'X' } });
    assert.equal(forbidden.code, 403);

    const created = await request('POST', '/pages', { body: { title: 'Routed Page' }, desktop: true });
    assert.equal(created.code, 201);
    const page = (created.body as { page: { id: string; revision: number } }).page;
    assert.ok(page.id.startsWith('page-'));

    const got = await request('GET', `/pages/${page.id}`);
    assert.equal(got.code, 200);

    const missing = await request('GET', '/pages/page-nope');
    assert.equal(missing.code, 404);
});

test('file write validates header, allowlist, and baseRevision (409)', async () => {
    const created = await request('POST', '/pages', { body: { title: 'Writable' }, desktop: true });
    const page = (created.body as { page: { id: string; revision: number } }).page;

    const noHeader = await request('PUT', `/pages/${page.id}/files/artifact.html`, { body: { content: '<p>x</p>', baseRevision: page.revision } });
    assert.equal(noHeader.code, 403);

    const ok = await request('PUT', `/pages/${page.id}/files/artifact.html`, { body: { content: '<p>v2</p>', baseRevision: page.revision }, desktop: true });
    assert.equal(ok.code, 200);
    const newRevision = (ok.body as { revision: number }).revision;
    assert.equal(newRevision, page.revision + 1);

    const stale = await request('PUT', `/pages/${page.id}/files/artifact.html`, { body: { content: '<p>stale</p>', baseRevision: page.revision }, desktop: true });
    assert.equal(stale.code, 409);

    const outsideAllowlist = await request('PUT', `/pages/${page.id}/files/evil.sh`, { body: { content: 'x', baseRevision: newRevision }, desktop: true });
    assert.equal(outsideAllowlist.code, 400);

    const read = await request('GET', `/pages/${page.id}/files/artifact.html`);
    assert.equal(read.code, 200);
    assert.ok((read.body as { content: string }).content.includes('v2'));
});

test('preview serves HTML with a script-blocking CSP', async () => {
    const created = await request('POST', '/pages', { body: { title: 'Previewed' }, desktop: true });
    const page = (created.body as { page: { id: string } }).page;
    const preview = await request('GET', `/pages/${page.id}/preview`);
    assert.equal(preview.code, 200);
    assert.ok(preview.raw && preview.raw.includes('<!doctype html>'));
    assert.equal(preview.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(preview.headers['content-security-policy'] ?? '', /script-src 'none'/);
    assert.equal(preview.headers['x-content-type-options'], 'nosniff');
});

test('patch conflicts on stale baseRevision and local-paths resolves', async () => {
    const created = await request('POST', '/pages', { body: { title: 'Patched' }, desktop: true });
    const page = (created.body as { page: { id: string; revision: number } }).page;

    const patched = await request('PATCH', `/pages/${page.id}`, { body: { title: 'Patched v2', baseRevision: page.revision }, desktop: true });
    assert.equal(patched.code, 200);

    const stale = await request('PATCH', `/pages/${page.id}`, { body: { title: 'Nope', baseRevision: page.revision }, desktop: true });
    assert.equal(stale.code, 409);

    const paths = await request('GET', `/pages/${page.id}/local-paths`);
    assert.equal(paths.code, 200);
    assert.ok((paths.body as { paths: { pageDir: string } }).paths.pageDir.length > 0);

    const rescan = await request('POST', '/pages/rescan');
    assert.equal(rescan.code, 200);
});

test('snapshots list after export-before gate and restore requires header', async () => {
    const created = await request('POST', '/pages', { body: { title: 'Snapped' }, desktop: true });
    const page = (created.body as { page: { id: string } }).page;
    const snapshots = await request('GET', `/pages/${page.id}/snapshots`);
    assert.equal(snapshots.code, 200);
    const restoreNoHeader = await request('POST', `/pages/${page.id}/snapshots/123-before/restore`);
    assert.equal(restoreNoHeader.code, 403);
});
