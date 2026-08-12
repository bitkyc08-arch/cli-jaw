import '../setup/isolated-home.ts';
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Express } from 'express';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

mock.module('../../src/security/security-audit-log.ts', {
    namedExports: { getSecurityAuditLog: () => ({ append: () => undefined }) },
});

const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const { applyRuntimeSettingsPatch } = await import('../../src/core/runtime-settings.ts');
const { wikiRouteManagedPatchPaths } = await import('../../src/core/config.ts');
const { DEFAULT_WIKI_CONFIG, normalizeWikiConfig, readWikiConfig, writeWikiConfig } =
    await import('../../src/wiki/config.ts');

type RouteHandler = (req: any, res: any, next: (error?: unknown) => void) => void;

function settingsPut(applySettings: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    const routes = new Map<string, RouteHandler[]>();
    const app = {
        get: () => undefined,
        post: () => undefined,
        put: (path: string, ...handlers: RouteHandler[]) => { routes.set(`PUT ${path}`, handlers); },
    } as unknown as Express;
    registerSettingsRoutes(app, ((_req: any, _res: any, next: () => void) => next()) as never,
        applySettings, process.cwd());
    return routes.get('PUT /api/settings')!;
}

async function request(handlers: RouteHandler[], body: Record<string, unknown>) {
    return await new Promise<{ status: number; json: Record<string, any> }>((resolve, reject) => {
        let status = 200;
        const response = {
            status(code: number) { status = code; return response; },
            json(json: Record<string, any>) { resolve({ status, json }); },
        };
        const run = (index: number): void => {
            const handler = handlers[index];
            if (!handler) return reject(new Error('route completed without a response'));
            handler({ body, ip: 'local', query: {}, params: {} }, response, (error?: unknown) => {
                if (error) reject(error);
                else run(index + 1);
            });
        };
        run(0);
    });
}

afterEach(async () => {
    await writeWikiConfig(normalizeWikiConfig(DEFAULT_WIKI_CONFIG));
});

test('generic settings API rejects wiki lifecycle fields but allows promptDigest', async () => {
    assert.deepEqual(wikiRouteManagedPatchPaths({ wiki: { enabled: true, root: '/tmp/unsafe' } }),
        ['wiki.enabled', 'wiki.root']);
    const patches: Record<string, unknown>[] = [];
    const put = settingsPut(async patch => { patches.push(patch); return patch; });

    const rejected = await request(put, { wiki: { enabled: true, root: '/tmp/unsafe' } });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.error, 'wiki_configuration_requires_wiki_route');
    assert.deepEqual(rejected.json.managedPaths, ['wiki.enabled', 'wiki.root']);
    assert.equal(JSON.stringify(rejected.json).includes('/tmp/unsafe'), false);
    assert.equal(patches.length, 0);

    const allowed = await request(put, { wiki: { promptDigest: true } });
    assert.equal(allowed.status, 200);
    assert.deepEqual(patches, [{ wiki: { promptDigest: true } }]);
});

test('shared runtime settings rejects wiki lifecycle fields without the wiki capability', async () => {
    const before = readWikiConfig();
    await assert.rejects(
        applyRuntimeSettingsPatch({ wiki: { enabled: true } }),
        /wiki_configuration_requires_wiki_route/,
    );
    assert.deepEqual(readWikiConfig(), before);
});

test('writeWikiConfig is the verified runtime capability for wiki lifecycle fields', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'jaw-wiki-boundary-')), 'vault');
    const expected = normalizeWikiConfig({ enabled: true, root, promptDigest: false });
    await writeWikiConfig(expected);
    assert.deepEqual(readWikiConfig(), expected);
});
