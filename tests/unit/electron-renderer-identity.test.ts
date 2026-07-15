import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import {
    CLI_JAW_ELECTRON_HEADER,
    electronRendererToken,
    isElectronRenderer,
    requireElectronRenderer,
} from '../../src/manager/electron-renderer-identity.js';

const ENV_NAME = 'CLI_JAW_ELECTRON_RENDERER_TOKEN';

function requestWith(value?: string): Request {
    return {
        get: (name: string) => name.toLowerCase() === CLI_JAW_ELECTRON_HEADER ? value : undefined,
    } as Request;
}

async function withToken(value: string | undefined, run: () => void | Promise<void>): Promise<void> {
    const previous = process.env[ENV_NAME];
    if (value === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = value;
    try {
        await run();
    } finally {
        if (previous === undefined) delete process.env[ENV_NAME];
        else process.env[ENV_NAME] = previous;
    }
}

test('renderer identity accepts only the configured per-launch token', async () => {
    await withToken('launch-token', () => {
        assert.equal(electronRendererToken(), 'launch-token');
        assert.equal(isElectronRenderer(requestWith('launch-token')), true);
        assert.equal(isElectronRenderer(requestWith('wrong-token!')), false);
        assert.equal(isElectronRenderer(requestWith('short')), false);
        assert.equal(isElectronRenderer(requestWith('1')), false);
        assert.equal(isElectronRenderer(requestWith()), false);
    });
});

test('renderer identity rejects every header when the launch token is empty or missing', async () => {
    await withToken('', () => {
        assert.equal(isElectronRenderer(requestWith('')), false);
        assert.equal(isElectronRenderer(requestWith('1')), false);
    });
    await withToken(undefined, () => {
        assert.equal(electronRendererToken(), '');
        assert.equal(isElectronRenderer(requestWith('launch-token')), false);
    });
});

test('renderer middleware uses the canonical 403 response', async () => {
    await withToken('launch-token', () => {
        let nextCalled = false;
        let status = 200;
        let body: unknown;
        const response = {
            status(code: number) { status = code; return this; },
            json(value: unknown) { body = value; return this; },
        } as unknown as Response;
        const next = (() => { nextCalled = true; }) as NextFunction;

        requireElectronRenderer(requestWith('1'), response, next);
        assert.equal(nextCalled, false);
        assert.equal(status, 403);
        assert.deepEqual(body, { ok: false, error: 'desktop renderer only' });

        requireElectronRenderer(requestWith('launch-token'), response, next);
        assert.equal(nextCalled, true);
    });
});
