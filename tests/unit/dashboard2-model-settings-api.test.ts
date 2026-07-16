import assert from 'node:assert/strict';
import test from 'node:test';
import {
    fetchCliRegistry,
    fetchDashboardRegistry,
    fetchInstanceSettings,
    patchDashboardRegistry,
    saveInstanceSettings,
    SettingsRequestError,
} from '../../public/dashboard2/src/features/settings/settings-api.ts';
import type { DashboardRegistryPatch } from '../../src/manager/types.ts';

const SECRET = 'SECRET_CANARY_SETTINGS_API_7f11';

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

test('model settings API uses direct dashboard GET/PATCH and worker GET/PUT paths', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        calls.push({ path, init });
        if (path === '/api/dashboard/registry') {
            return json({ registry: { ui: {} }, status: { source: 'disk' } });
        }
        if (path === '/i/3457/api/settings') {
            return json({ ok: true, data: { cli: 'codex' } });
        }
        if (path === '/i/3457/api/cli-registry') {
            return json({ ok: true, data: { codex: { models: ['gpt-5.5'] } } });
        }
        throw new Error(`unexpected path ${path}`);
    }) as typeof fetch;

    await fetchDashboardRegistry({ fetchImpl });
    await patchDashboardRegistry({ ui: { locale: 'en' } } as DashboardRegistryPatch, { fetchImpl });
    await fetchInstanceSettings(3457, { fetchImpl });
    await saveInstanceSettings(3457, { perCli: { codex: { model: 'gpt-5.5' } } }, { fetchImpl });
    await fetchCliRegistry(3457, { fetchImpl });

    assert.deepEqual(calls.map(call => [call.path, call.init?.method ?? 'GET']), [
        ['/api/dashboard/registry', 'GET'],
        ['/api/dashboard/registry', 'PATCH'],
        ['/i/3457/api/settings', 'GET'],
        ['/i/3457/api/settings', 'PUT'],
        ['/i/3457/api/cli-registry', 'GET'],
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { ui: { locale: 'en' } });
    assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
        perCli: { codex: { model: 'gpt-5.5' } },
    });
});

test('2xx HTML is typed invalid_content_type and non-2xx bodies never leak', async () => {
    const htmlFetch = (async () => new Response('<!doctype html>manager shell', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch;
    await assert.rejects(
        fetchDashboardRegistry({ fetchImpl: htmlFetch }),
        (error: unknown) => error instanceof SettingsRequestError
            && error.code === 'invalid_content_type'
            && !error.message.includes('manager shell'),
    );

    const errorFetch = (async () => json({ ok: false, error: SECRET }, 500)) as typeof fetch;
    await assert.rejects(
        fetchInstanceSettings(3457, { fetchImpl: errorFetch }),
        (error: unknown) => error instanceof SettingsRequestError
            && error.code === 'http_error'
            && error.status === 500
            && !error.message.includes(SECRET),
    );
});

test('malformed success and invalid JSON fail without reflecting response content', async () => {
    const malformedFetch = (async () => json({ ok: false, error: SECRET })) as typeof fetch;
    await assert.rejects(
        fetchCliRegistry(3457, { fetchImpl: malformedFetch }),
        (error: unknown) => error instanceof SettingsRequestError
            && error.code === 'invalid_response'
            && !error.message.includes(SECRET),
    );
    const invalidJsonFetch = (async () => new Response(`{"token":"${SECRET}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await assert.rejects(
        fetchInstanceSettings(3457, { fetchImpl: invalidJsonFetch }),
        (error: unknown) => error instanceof SettingsRequestError
            && error.code === 'invalid_json'
            && !error.message.includes(SECRET),
    );
});
