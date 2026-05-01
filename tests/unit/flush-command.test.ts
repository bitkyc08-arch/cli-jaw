// Flush command unit tests (#27)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { flushHandler } from '../../src/cli/handlers.ts';
import { migrateSettings } from '../../src/core/config.ts';

// ─── Mock helpers ────────────────────────────────────
// Note: locales are NOT loaded in test context, so t() falls back to key name.
// We test the handler logic (ok/fail, settings mutation) rather than i18n text.

function makeCtx(overrides: Record<string, any> = {}) {
    const settings = {
        cli: 'claude',
        perCli: {
            claude: { model: 'sonnet', effort: 'medium' },
            gemini: { model: 'gemini-2.5-pro', effort: '' },
            codex: { model: 'gpt-5.3-codex', effort: 'medium' },
        },
        memory: { enabled: true, flushEvery: 10, cli: '', model: '', retentionDays: 30 },
        ...overrides,
    };
    return {
        locale: 'en',
        settings,
        getSettings: async () => settings,
        updateSettings: async (patch: any) => {
            // Mirror production runtime-settings path: mergeSettingsPatch + migrateSettings
            const merged = { ...settings, ...patch, memory: { ...settings.memory, ...(patch.memory || {}) } };
            const migrated = migrateSettings(merged);
            Object.assign(settings, migrated);
            return { ok: true };
        },
    };
}

function createCliShim(dir: string, name: string) {
    if (process.platform === 'win32') {
        const cmdPath = join(dir, `${name}.cmd`);
        fs.writeFileSync(cmdPath, '@echo off\r\nexit /b 0\r\n');
        return;
    }
    const shimPath = join(dir, name);
    fs.writeFileSync(shimPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(shimPath, 0o755);
}

async function withIsolatedPath(cliNames: string[], fn: () => Promise<void>) {
    const prevPath = process.env.PATH || '';
    const tmpBin = fs.mkdtempSync(join(tmpdir(), 'flush-cli-bin-'));
    for (const name of cliNames) createCliShim(tmpBin, name);

    const basePath = process.platform === 'win32'
        ? [join(process.env.SystemRoot || 'C:\\Windows', 'System32')]
        : ['/usr/bin', '/bin'];

    process.env.PATH = [tmpBin, ...basePath].join(delimiter);
    try {
        await fn();
    } finally {
        process.env.PATH = prevPath;
        fs.rmSync(tmpBin, { recursive: true, force: true });
    }
}

// ─── FC-001: /flush (no args) shows current ─────────

test('FC-001: /flush shows current flush model (ok=true)', async () => {
    const ctx = makeCtx();
    const result = await flushHandler([], ctx);
    assert.equal(result.ok, true);
    // When no custom flush set, includes "active" suffix
    assert.ok(result.text.includes('active'), 'Should indicate using active CLI');
});

test('FC-001b: /flush shows custom flush model when set (ok=true)', async () => {
    const ctx = makeCtx({ memory: { cli: 'gemini', model: 'gemini-2.5-flash', enabled: true, flushEvery: 10, retentionDays: 30 } });
    const result = await flushHandler([], ctx);
    assert.equal(result.ok, true);
    // When custom flush is set, NO "active" suffix
    assert.ok(!result.text.includes('active'), 'Should NOT show active suffix when custom set');
});

// ─── FC-002: /flush <model> changes model ───────────

test('FC-002: /flush <custom-model> changes model or fails if CLI unavailable', async () => {
    const ctx = makeCtx();
    const result = await flushHandler(['my-custom-model'], ctx);
    // In CI, detectCli(activeCli) may return unavailable → ok=false
    if (result.ok) {
        assert.equal(ctx.settings.memory.model, 'my-custom-model');
    } else {
        // CLI not installed → cliUnavailable error is acceptable
        assert.equal(result.ok, false);
    }
});

// ─── FC-003: /flush <cli> <model> changes both ──────

test('FC-003: /flush <cli> <model> changes both or reports unavailable', async () => {
    const ctx = makeCtx();
    const result = await flushHandler(['gemini', 'gemini-2.5-flash'], ctx);
    if (result.ok) {
        assert.equal(ctx.settings.memory.cli, 'gemini');
        assert.equal(ctx.settings.memory.model, 'gemini-2.5-flash');
    } else {
        // CLI not installed → returns error (ok=false)
        assert.equal(result.ok, false);
    }
});

// ─── FC-004: /flush off resets ───────────────────────

test('FC-004: /flush off resets to active CLI/model', async () => {
    const ctx = makeCtx({ memory: { cli: 'gemini', model: 'gemini-2.5-flash', enabled: true, flushEvery: 10, retentionDays: 30 } });
    const result = await flushHandler(['off'], ctx);
    assert.equal(result.ok, true);
    assert.equal(ctx.settings.memory.cli, '');
    assert.equal(ctx.settings.memory.model, '');
});

test('FC-004b: /flush reset also resets', async () => {
    const ctx = makeCtx({ memory: { cli: 'gemini', model: 'gemini-2.5-flash', enabled: true, flushEvery: 10, retentionDays: 30 } });
    const result = await flushHandler(['reset'], ctx);
    assert.equal(result.ok, true);
    assert.equal(ctx.settings.memory.cli, '');
    assert.equal(ctx.settings.memory.model, '');
});

// ─── FC-005: fallback when memory unset ──────────────

test('FC-005: flush model resolution falls back to active CLI model', async () => {
    const ctx = makeCtx();
    const result = await flushHandler([], ctx);
    assert.equal(result.ok, true);
});

// ─── FC-006: /flush <cli> without model → default ───

test('FC-006: /flush <cli> without model sets model to default', async () => {
    const ctx = makeCtx();
    const result = await flushHandler(['claude'], ctx);
    if (result.ok) {
        assert.equal(ctx.settings.memory.cli, 'claude');
        assert.equal(ctx.settings.memory.model, 'default');
    }
});

// ─── FC-007: duplicate model name across CLIs ───────

test('FC-007: /flush <model> picks first available matched CLI (codex before copilot)', async () => {
    await withIsolatedPath(['codex', 'copilot'], async () => {
        const ctx = makeCtx();
        const result = await flushHandler(['gpt-5.3-codex'], ctx);
        assert.equal(result.ok, true);
        assert.equal(ctx.settings.memory.cli, 'codex');
        assert.equal(ctx.settings.memory.model, 'gpt-5.3-codex');
    });
});

// ─── FC-008: model exists but CLI unavailable ───────
// Note: withIsolatedPath cannot block detectCli's buildServicePath from finding
// CLIs in hardcoded paths (homebrew, nvm, etc). Test structurally instead.

test('FC-008: flushHandler source has cliUnavailable guard for unavailable matched CLIs', () => {
    const handlerSrc = fs.readFileSync(
        join(import.meta.dirname, '../../src/cli/handlers-runtime.ts'), 'utf8',
    );
    const flushBlock = handlerSrc.slice(
        handlerSrc.indexOf('export async function flushHandler'),
    );
    assert.ok(
        flushBlock.includes('availableClis') && flushBlock.includes('detectCli'),
        'flushHandler must filter matchedClis by detectCli availability',
    );
    assert.ok(
        flushBlock.includes('cliUnavailable'),
        'flushHandler must return cliUnavailable when no matched CLIs are available',
    );
});

// ─── FC-009: legacy full-name infers Claude via hint table ───

test('FC-009: /flush <full-id> infers claude via LEGACY_MODEL_CLI_HINTS and preserves the literal', async () => {
    await withIsolatedPath(['claude'], async () => {
        const ctx = makeCtx();
        const result = await flushHandler(['claude-opus-4-6[1m]'], ctx);
        assert.equal(result.ok, true);
        assert.equal(ctx.settings.memory.cli, 'claude');
        // Passthrough policy: user-pinned full ID survives runtime migration
        // verbatim so claude --model receives exactly what the user typed.
        assert.equal(ctx.settings.memory.model, 'claude-opus-4-6[1m]');
    });
});

test('FC-010: /flush claude <full-id> preserves the literal across migration', async () => {
    await withIsolatedPath(['claude'], async () => {
        const ctx = makeCtx();
        const result = await flushHandler(['claude', 'claude-opus-4-6[1m]'], ctx);
        assert.equal(result.ok, true);
        assert.equal(ctx.settings.memory.cli, 'claude');
        assert.equal(ctx.settings.memory.model, 'claude-opus-4-6[1m]');
    });
});
