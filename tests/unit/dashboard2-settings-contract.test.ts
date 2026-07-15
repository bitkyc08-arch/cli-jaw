import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInstanceSettingsAdapter } from '../../public/dashboard2/src/features/settings/settings-category-adapters.ts';
import {
    normalizeSettingsResponse,
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

test('settings response normalization accepts real envelopes and rejects malformed success', () => {
    assert.deepEqual(normalizeSettingsResponse({ cli: 'codex' }), { cli: 'codex' });
    assert.deepEqual(normalizeSettingsResponse({ ok: true, data: { cli: 'codex' } }), { cli: 'codex' });
    assert.deepEqual(normalizeSettingsResponse({ registry: { ui: { locale: 'ko' } } }), { ui: { locale: 'ko' } });
    assert.deepEqual(normalizeSettingsResponse({ preferences: { ui: { locale: 'en' } } }), { ui: { locale: 'en' } });
    assert.throws(() => normalizeSettingsResponse({ ok: false, error: 'denied' }), /denied/);
    assert.throws(() => normalizeSettingsResponse({ ok: true, data: 'not-an-object' }), /Malformed settings response/);
    assert.throws(() => normalizeSettingsResponse(null), /Malformed settings response/);
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

test('unsupported categories cannot encode settings and render disabled guidance', () => {
    assert.deepEqual(getInstanceSettingsAdapter('unsupported').encode({ apiKeys: { openai: 'secret' } }, {}, {}), {});
    const pagePaths = ['AgentPage', 'McpPage', 'ModelProviderPage', 'NetworkPage'];
    for (const page of pagePaths) {
        const source = readSource(join(projectRoot, `public/dashboard2/src/features/settings/pages/${page}.tsx`), 'utf8');
        assert.match(source, /unsupported:/, `${page} must mark unsupported controls`);
    }
    const shell = readSource(join(projectRoot, 'public/dashboard2/src/features/settings/SettingsPageShell.tsx'), 'utf8');
    assert.match(shell, /disabled=\{disabled\}/, 'unsupported controls must be disabled');
    assert.match(shell, /Unsupported: \{field\.unsupported\}/, 'unsupported reason must be visible');
});
