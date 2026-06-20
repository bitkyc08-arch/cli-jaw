import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import { resolve } from 'node:path';

// Slice 210a reinforcement (pre-220): the source-string contract in
// code-workspace-pick-route-contract.test.ts locks the PickResult -> HTTP map
// statically. This test exercises the registered route at RUNTIME with a mocked
// native picker so the actual status codes and response bodies are proven, not
// just the source text. Closes the auditor's "static contract, no runtime
// behavior" reinforcement gap for the workspace picker route.

type PickResult =
    | { status: 'picked'; path: string }
    | { status: 'cancelled' }
    | { status: 'busy' }
    | { status: 'unavailable'; reason: string };

// Mutable holder so each test can drive a different PickResult (or throw).
const pick: { next: () => Promise<PickResult> } = {
    next: async () => ({ status: 'cancelled' }),
};

const folderPickerPath = resolve(import.meta.dirname, '../../src/core/folder-picker.js');
mock.module(folderPickerPath, {
    namedExports: {
        pickFolderNative: async () => pick.next(),
    },
});

// registerCodeRoutes pulls in acp-host at module load; mock it the same way
// code-routes.test.ts does so the route module imports without starting jwc.
const acpHostPath = resolve(import.meta.dirname, '../../src/code-mode/acp-host.js');
mock.module(acpHostPath, {
    namedExports: {
        acpHost: {
            listSessions: () => [],
            listPendingPermissions: () => [],
            listStoredSessions: async () => [],
            loadSession: async () => { throw new Error('not used'); },
            extMethod: async () => ({}),
            forkSession: async () => { throw new Error('not used'); },
            newSession: async () => { throw new Error('not used'); },
            setSessionModel: async () => {},
            prompt: async () => ({ accepted: true, sessionId: 'unused' }),
            cancel: async () => {},
            setSessionConfig: async () => {},
            closeSession: async () => {},
            answerPermission: () => false,
        },
    },
});

const { registerCodeRoutes } = await import('../../src/routes/code.ts');

const noAuth = (_req: Request, _res: Response, next: NextFunction) => next();

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    registerCodeRoutes(app, noAuth);
    const server = app.listen(0);
    try {
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        await fn(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>(r => server.close(() => r()));
    }
}

test('picked status returns 200 with the chosen path and no settings mutation fields', async () => {
    pick.next = async () => ({ status: 'picked', path: '/tmp/chosen-workspace' });
    await withServer(async baseUrl => {
        const res = await fetch(`${baseUrl}/api/code/workspace/pick`, { method: 'POST' });
        assert.equal(res.status, 200);
        const body = await res.json() as Record<string, unknown>;
        assert.deepEqual(body, { ok: true, path: '/tmp/chosen-workspace' });
        assert.equal('projectDirs' in body, false, 'response must not echo projectDirs');
    });
});

test('cancelled status returns 200 with cancelled flag', async () => {
    pick.next = async () => ({ status: 'cancelled' });
    await withServer(async baseUrl => {
        const res = await fetch(`${baseUrl}/api/code/workspace/pick`, { method: 'POST' });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, cancelled: true });
    });
});

test('busy status maps to 409', async () => {
    pick.next = async () => ({ status: 'busy' });
    await withServer(async baseUrl => {
        const res = await fetch(`${baseUrl}/api/code/workspace/pick`, { method: 'POST' });
        assert.equal(res.status, 409);
        const body = await res.json() as Record<string, unknown>;
        assert.equal(body['ok'], false);
    });
});

test('unavailable status maps to 503 and surfaces the reason', async () => {
    pick.next = async () => ({ status: 'unavailable', reason: 'no display server' });
    await withServer(async baseUrl => {
        const res = await fetch(`${baseUrl}/api/code/workspace/pick`, { method: 'POST' });
        assert.equal(res.status, 503);
        const body = await res.json() as Record<string, unknown>;
        assert.equal(body['ok'], false);
        assert.equal(body['error'], 'no display server');
    });
});

test('picker throwing maps to 500 with the error message', async () => {
    pick.next = async () => { throw new Error('picker exploded'); };
    await withServer(async baseUrl => {
        const res = await fetch(`${baseUrl}/api/code/workspace/pick`, { method: 'POST' });
        assert.equal(res.status, 500);
        const body = await res.json() as Record<string, unknown>;
        assert.equal(body['ok'], false);
        assert.equal(body['error'], 'picker exploded');
    });
});
