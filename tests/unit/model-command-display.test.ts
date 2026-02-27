import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLocales } from '../../src/core/i18n.ts';
import { modelHandler } from '../../src/cli/handlers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadLocales(join(__dirname, '../../public/locales'));

function makeCtx(overrides: Record<string, any> = {}) {
    const settings = {
        cli: 'gemini',
        perCli: {
            gemini: { model: 'gemini-3-flash-preview', effort: '' },
            codex: { model: 'gpt-5.3-codex', effort: 'medium' },
        },
        activeOverrides: {},
        ...overrides,
    };

    const session = {
        active_cli: settings.cli,
        model: settings.perCli?.[settings.cli]?.model || 'default',
        ...(overrides.session || {}),
    };

    return {
        locale: 'en',
        settings,
        session,
        getSettings: async () => settings,
        getSession: async () => session,
        updateSettings: async (patch: any) => {
            if (patch.perCli) settings.perCli = { ...settings.perCli, ...patch.perCli };
            if (patch.activeOverrides) settings.activeOverrides = { ...settings.activeOverrides, ...patch.activeOverrides };
            if (patch.cli) settings.cli = patch.cli;

            const activeCli = settings.cli || 'claude';
            const aoModel = settings.activeOverrides?.[activeCli]?.model;
            const perCliModel = settings.perCli?.[activeCli]?.model;
            session.active_cli = activeCli;
            session.model = aoModel || perCliModel || session.model || 'default';
            return { ok: true };
        },
    };
}

test('MD-001: /model shows active CLI perCli model by default', async () => {
    const ctx = makeCtx();
    const result = await modelHandler([], ctx);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes('gemini-3-flash-preview'));
});

test('MD-002: /model prefers activeOverrides model over perCli model', async () => {
    const ctx = makeCtx({
        activeOverrides: {
            gemini: { model: 'gemini-2.5-flash' },
        },
        session: {
            active_cli: 'gemini',
            model: 'gemini-3.0-pro-preview',
        },
    });
    const result = await modelHandler([], ctx);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes('gemini-2.5-flash'));
});

test('MD-003: /model uses session model when session active CLI matches', async () => {
    const ctx = makeCtx({
        session: {
            active_cli: 'gemini',
            model: 'gemini-2.5-flash',
        },
    });
    const result = await modelHandler([], ctx);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes('gemini-2.5-flash'));
});

test('MD-004: /model does not leak session model from different CLI', async () => {
    const ctx = makeCtx({
        session: {
            active_cli: 'codex',
            model: 'gpt-5.3-codex',
        },
    });
    const result = await modelHandler([], ctx);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes('gemini-3-flash-preview'));
    assert.ok(!result.text.includes('gpt-5.3-codex'));
});

test('MD-005: /model <new> then /model shows the updated model', async () => {
    const ctx = makeCtx();
    const change = await modelHandler(['gemini-2.5-flash'], ctx);
    assert.equal(change.ok, true);
    assert.equal(ctx.settings.perCli.gemini.model, 'gemini-2.5-flash');

    const current = await modelHandler([], ctx);
    assert.equal(current.ok, true);
    assert.ok(current.text.includes('gemini-2.5-flash'));
});
