import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInstanceSettingsAdapter } from '../../public/dashboard2/src/features/settings/settings-category-adapters.ts';
import {
    decodeCliRegistryResponse,
    decodeDashboardRegistryResponse,
    decodeWorkerSettingsResponse,
    saveInstanceSettings,
} from '../../public/dashboard2/src/features/settings/settings-api.ts';
import { readSource } from './source-normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

test('instance settings use PUT with a partial patch body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, data: { cli: 'codex', perCli: { codex: { model: 'o3' } } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as typeof fetch;
    try {
        const result = await saveInstanceSettings(3456, { perCli: { codex: { model: 'o3' } } });
        assert.equal(calls[0]?.url, '/i/3456/api/settings');
        assert.equal(calls[0]?.init?.method, 'PUT');
        assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { perCli: { codex: { model: 'o3' } } });
        assert.equal(result['cli'], 'codex');
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('settings API uses three exact response decoders', () => {
    assert.deepEqual(
        decodeDashboardRegistryResponse({ registry: { ui: {} }, status: { source: 'disk' } }),
        { registry: { ui: {} }, status: { source: 'disk' } },
    );
    assert.deepEqual(decodeWorkerSettingsResponse({ ok: true, data: { cli: 'codex' } }), { cli: 'codex' });
    assert.deepEqual(decodeCliRegistryResponse({ ok: true, data: { codex: { models: ['gpt-5.5'] } } }), {
        codex: { models: ['gpt-5.5'] },
    });
    assert.throws(() => decodeWorkerSettingsResponse({ cli: 'codex' }), /invalid response/);
    assert.throws(() => decodeCliRegistryResponse({ ok: false, data: {} }), /invalid response/);
    assert.throws(() => decodeDashboardRegistryResponse({ ok: true, data: {} }), /invalid response/);
});

test('Agent adapter maps only the selected CLI model', () => {
    const adapter = getInstanceSettingsAdapter('agent');
    const root = {
        cli: 'codex',
        perCli: { codex: { model: 'o3', effort: 'high' }, claude: { model: 'sonnet' } },
        temperature: 0.5,
        systemPrompt: 'must not round-trip',
    };
    const initial = adapter.decode(root);
    assert.deepEqual(initial, { model: 'o3' });
    assert.deepEqual(adapter.encode({ model: 'o4' }, initial, root), { perCli: { codex: { model: 'o4' } } });
    assert.deepEqual(adapter.encode({ model: 'o3' }, initial, root), {});
    assert.throws(() => adapter.encode({ model: 'o4' }, initial, { cli: 'missing', perCli: {} }), /Selected CLI/);
});

test('Memory adapter maps the four allowlisted canonical keys and changed fields only', () => {
    const adapter = getInstanceSettingsAdapter('memory');
    const root = {
        memory: {
            enabled: true,
            flushEvery: 10,
            retentionDays: 30,
            autoReflectAfterFlush: false,
            model: 'private-model',
        },
    };
    const initial = adapter.decode(root);
    assert.deepEqual(initial, { enabled: true, flushEvery: 10, retentionDays: 30, autoReflect: false });
    assert.deepEqual(
        adapter.encode({ ...initial, flushEvery: 20, autoReflect: true }, initial, root),
        { memory: { flushEvery: 20, autoReflectAfterFlush: true } },
    );
    assert.throws(() => adapter.encode({ ...initial, retentionDays: 0 }, initial, root), /1 to 3650/);
});

test('Network adapter maps the canonical allowlist and sends complete remoteAccess objects', () => {
    const adapter = getInstanceSettingsAdapter('network');
    const root = {
        network: {
            bindHost: '127.0.0.1',
            lanBypass: false,
            remoteAccess: {
                mode: 'off',
                trustProxies: false,
                trustForwardedFor: false,
                publicOriginHint: '',
                requireAuth: true,
                privateField: 'must not round-trip',
            },
            privateField: 'must not round-trip',
        },
        apiKeys: { openai: 'must not round-trip' },
    };
    const initial = adapter.decode(root);
    assert.deepEqual(initial, {
        bindHost: '127.0.0.1',
        lanBypass: false,
        remoteAccess: {
            mode: 'off',
            trustProxies: false,
            trustForwardedFor: false,
            publicOriginHint: '',
            requireAuth: true,
        },
    });

    assert.deepEqual(adapter.encode(initial, initial, root), {});
    assert.deepEqual(
        adapter.encode({
            ...initial,
            remoteAccess: { ...initial['remoteAccess'] as Record<string, unknown>, mode: 'full' },
        }, initial, root),
        {
            network: {
                remoteAccess: {
                    mode: 'full',
                    trustProxies: false,
                    trustForwardedFor: false,
                    publicOriginHint: '',
                    requireAuth: true,
                },
            },
        },
    );
    assert.deepEqual(
        adapter.encode({ ...initial, bindHost: '0.0.0.0' }, initial, root),
        {
            network: {
                bindHost: '0.0.0.0',
                remoteAccess: {
                    mode: 'off',
                    trustProxies: false,
                    trustForwardedFor: false,
                    publicOriginHint: '',
                    requireAuth: true,
                },
            },
        },
    );
});

test('Network adapter rejects values outside the persistence allowlist', () => {
    const adapter = getInstanceSettingsAdapter('network');
    const initial = adapter.decode({ network: {} });
    const remoteAccess = initial['remoteAccess'] as Record<string, unknown>;

    assert.throws(
        () => adapter.encode({ ...initial, remoteAccess: { ...remoteAccess, mode: 'reverse-proxy' } }, initial, {}),
        /Remote access mode/,
    );
    assert.throws(
        () => adapter.encode({ ...initial, remoteAccess: { ...remoteAccess, publicOriginHint: 'ws:\/\/bad' } }, initial, {}),
        /Public origin hint/,
    );
    assert.throws(() => adapter.encode({ ...initial, lanBypass: 'yes' }, initial, {}), /LAN bypass/);
});

test('Network page exposes only canonical persistent fields and restart guidance', () => {
    const source = readSource(join(projectRoot, 'public/dashboard2/src/features/settings/pages/NetworkPage.tsx'), 'utf8');
    const keys = [...source.matchAll(/\{ key: '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(keys, [
        'bindHost',
        'lanBypass',
        'remoteAccess.mode',
        'remoteAccess.trustProxies',
        'remoteAccess.trustForwardedFor',
        'remoteAccess.publicOriginHint',
        'remoteAccess.requireAuth',
    ]);
    assert.match(source, /adapterId="network"/);
    assert.doesNotMatch(source, /proxyUrl|tlsVerify|key: 'trustProxy'/);
    assert.equal((source.match(/restart the instance/gi) ?? []).length, 4,
        'bindHost and startup-captured mode/trust fields must be marked restart-required');
});

test('unsupported categories cannot encode settings and MCP renders disabled guidance', () => {
    assert.deepEqual(getInstanceSettingsAdapter('unsupported').encode({ apiKeys: { openai: 'secret' } }, {}, {}), {});
    const mcp = readSource(join(projectRoot, 'public/dashboard2/src/features/settings/pages/McpPage.tsx'), 'utf8');
    assert.match(mcp, /unsupported:/, 'McpPage must mark unsupported controls');
    const shell = readSource(join(projectRoot, 'public/dashboard2/src/features/settings/SettingsPageShell.tsx'), 'utf8');
    assert.match(shell, /disabled=\{disabled\}/, 'unsupported controls must be disabled');
    assert.match(shell, /Unsupported: \{field\.unsupported\}/, 'unsupported reason must be visible');
});

test('Agent and Model Provider pages expose the controlled default model settings panel', () => {
    for (const page of ['AgentPage', 'ModelProviderPage']) {
        const source = readSource(join(projectRoot, `public/dashboard2/src/features/settings/pages/${page}.tsx`), 'utf8');
        assert.match(source, /ModelSettingsPanel/);
        assert.match(source, /mode="default"/);
        assert.doesNotMatch(source, /unsupported:/);
    }
});
