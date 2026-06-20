import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';

const kiroModelsPath = resolve(import.meta.dirname, '../../src/agent/kiro-models.js');

// Isolate the live-registry Kiro augmentation boundary; 270 is about JWC exposure.
mock.module(kiroModelsPath, {
    namedExports: {
        fetchKiroModelInventory: async () => null,
    },
});

const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');

const noAuth = (_req: Request, _res: Response, next: NextFunction): void => next();

test('/api/cli-registry exposes JWC runtime metadata', async () => {
    const app = express();
    app.use(express.json());
    registerSettingsRoutes(app, noAuth, async () => ({}), process.cwd());
    const server = app.listen(0);

    try {
        const address = server.address();
        assert.ok(address && typeof address === 'object');

        const response = await fetch(`http://127.0.0.1:${address.port}/api/cli-registry`);
        assert.equal(response.status, 200);

        const body = await response.json() as { ok: boolean; data: Record<string, Record<string, unknown>> };
        assert.equal(body.ok, true);
        assert.equal(body.data.jwc.label, 'JWC');
        assert.equal(body.data.jwc.binary, 'jwc');
        assert.equal(body.data.jwc.experimental, true);
        assert.equal(body.data.jwc.defaultModel, 'claude-sonnet-4-6');
        assert.equal(body.data.jwc.defaultEffort, 'high');
    } finally {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
});
