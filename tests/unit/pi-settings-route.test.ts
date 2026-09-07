import '../setup/isolated-home.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Express, Request, Response, RequestHandler } from 'express';
import { settings, JAW_HOME } from '../../src/core/config.ts';

const pi = await import('../../src/agent/pi-runtime.ts');
let discovered = ['selected-model', 'discovery-only-model'];
const discoveryCalls: string[] = [];
mock.module('../../src/agent/pi-runtime.js', { namedExports: {
    ...pi,
    async discoverPiProfileModels(_settings: unknown, profile: { id: string }) {
        discoveryCalls.push(profile.id); return { models: [...discovered], source: 'pi-offline' };
    },
    async listPiModels() { assert.fail('unexpected fallback discovery'); },
} });
const { registerSettingsRoutes } = await import('../../src/routes/settings.ts');
const routes = new Map<string, RequestHandler[]>();
const patches: Record<string, unknown>[] = [];
let denied = false;
// Registration only: no HTTP listener or provider process is opened.
const recorder = Object.fromEntries(['get', 'post', 'put', 'delete', 'patch'].map(method => [method,
    (path: string, ...handlers: RequestHandler[]) => { routes.set(method.toUpperCase() + ' ' + path, handlers); },
])) as unknown as Express;
registerSettingsRoutes(recorder, (_req, res, next) => {
    if (denied) res.status(403).json({ ok: false, error: 'fixture_auth_denied' }); else next();
}, async patch => { patches.push(patch); return { ...settings, ...patch }; }, JAW_HOME);

async function invoke(method: string, path: string, body: unknown = {}, query: Record<string, string> = {}) {
    const handlers = routes.get(method + ' ' + path); assert.ok(handlers);
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
            timer = setTimeout(() => reject(Error('route fixture deadline')), 2000);
            let status = 200, index = 0;
            const response = { status(code: number) { status = code; return response; },
                json(value: unknown) { resolve({ status, body: JSON.parse(JSON.stringify(value)) }); },
            } as unknown as Response;
            const req = { body, query } as Request;
            const next = (error?: unknown) => {
                if (error) { reject(error); return; }
                const handler = handlers[index++];
                if (!handler) { reject(Error('route did not return a response')); return; }
                try { handler(req, response, next); } catch (error) { reject(error); }
            };
            next();
        });
    } finally { clearTimeout(timer!); }
}
test.beforeEach(t => {
    denied = false; patches.length = 0; discoveryCalls.length = 0;
    discovered = ['selected-model', 'discovery-only-model'];
    settings.pi = pi.normalizePiSettings(pi.DEFAULT_PI_SETTINGS);
    t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected network'); });
});
test.after(() => mock.restoreAll());
const registration = { id: 'fixture', label: 'Fixture', mode: 'basic', endpoint: 'https://example.invalid/v1',
    model: 'selected-model', apiKey: 'ONLY_TEST_SECRET_ABCD' };

test('Pi registration returns nested models and redacted settings with no root compatibility fields', async () => {
    const response = await invoke('POST', '/api/pi/profiles/register', registration);
    assert.equal(response.status, 200); assert.deepEqual(Object.keys(response.body).sort(), ['data', 'ok']);
    assert.equal(response.body.ok, true);
    const data = response.body.data as { models: string[]; modelSource: string; profile: Record<string, unknown>;
        settings: { pi: { discoveredModels: Record<string, string[]>; profiles: Array<Record<string, unknown>> } } };
    assert.deepEqual(data.models, ['selected-model', 'discovery-only-model']);
    assert.deepEqual(data.settings.pi.discoveredModels.fixture, data.models);
    assert.equal(data.modelSource, 'pi-offline'); assert.equal(patches.length, 1);
    assert.deepEqual(discoveryCalls, ['fixture']);
    assert.equal(data.profile.apiKeySet, true); assert.equal(data.profile.apiKeyLast4, 'ABCD');
    assert.equal(data.profile.apiKey, undefined);
    assert.doesNotMatch(JSON.stringify(response.body), /ONLY_TEST_SECRET/);
});

test('Pi registration discovery rejection returns 400 before settings application', async () => {
    discovered = ['different-model'];
    const response = await invoke('POST', '/api/pi/profiles/register', registration);
    assert.equal(response.status, 400); assert.equal(response.body.ok, false); assert.equal(patches.length, 0);
});

test('Pi route admission denial prevents model discovery and settings application', async () => {
    denied = true;
    const response = await invoke('POST', '/api/pi/profiles/register', registration);
    assert.equal(response.status, 403); assert.deepEqual(discoveryCalls, []); assert.deepEqual(patches, []);
});

test('Pi model discovery selects the explicit profile and returns an ok/data envelope', async () => {
    const response = await invoke('GET', '/api/pi/models', {}, { profile: 'progrok' });
    assert.equal(response.status, 200); assert.deepEqual(response.body, { ok: true,
        data: { profile: 'progrok', models: ['selected-model', 'discovery-only-model'], modelSource: 'pi-offline' } });
    assert.deepEqual(discoveryCalls, ['progrok']); assert.deepEqual(patches, []);
});

test('unknown Pi profile is rejected without discovery', async () => {
    const response = await invoke('GET', '/api/pi/models', {}, { profile: 'missing' });
    assert.equal(response.status, 400); assert.equal(response.body.ok, false); assert.deepEqual(discoveryCalls, []);
});
