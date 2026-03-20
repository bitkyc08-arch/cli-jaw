import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeCommandCtx } from '../../src/cli/command-context.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ctxSrc = fs.readFileSync(join(__dirname, '../../src/cli/command-context.ts'), 'utf8');
const serverSrc = fs.readFileSync(join(__dirname, '../../server.ts'), 'utf8');
const botSrc = fs.readFileSync(join(__dirname, '../../src/telegram/bot.ts'), 'utf8');
const skillCmdSrc = fs.readFileSync(join(__dirname, '../../bin/commands/skill.ts'), 'utf8');

// ─── CC-001: makeCommandCtx exports exist ───

test('CC-001: makeCommandCtx function is exported', () => {
    assert.ok(ctxSrc.includes('export function makeCommandCtx'), 'makeCommandCtx should be exported');
});

// ─── CC-002: unified MCP — no empty objects ───

test('CC-002: getMcp returns real loadUnifiedMcp, not empty object', () => {
    assert.ok(ctxSrc.includes('getMcp: () => loadUnifiedMcp()'), 'getMcp uses loadUnifiedMcp');
    assert.ok(!ctxSrc.includes("getMcp: () => ({ servers: {} })"), 'no empty MCP stub');
});

// ─── CC-003: TG settings restriction is in makeCommandCtx ───

test('CC-003: telegram interface restricts settings via allowlist', () => {
    assert.ok(
        ctxSrc.includes("iface === 'telegram'"),
        'makeCommandCtx checks for telegram interface',
    );
    assert.ok(
        ctxSrc.includes('tg.settingsUnsupported'),
        'returns unsupported message for disallowed patches',
    );
    assert.ok(
        ctxSrc.includes('TG_ALLOWED_SETTINGS_KEYS'),
        'uses Set-based allowlist for telegram settings',
    );
});

// ─── CC-004: server.ts uses makeCommandCtx ───

test('CC-004: server.ts uses makeCommandCtx instead of inline object', () => {
    assert.ok(
        serverSrc.includes("import { makeCommandCtx }"),
        'server.ts imports makeCommandCtx',
    );
    assert.ok(
        serverSrc.includes("makeCommandCtx('web'"),
        'server.ts calls makeCommandCtx with web interface',
    );
});

// ─── CC-005: bot.ts uses makeCommandCtx ───

test('CC-005: bot.ts uses makeCommandCtx instead of inline object', () => {
    assert.ok(
        botSrc.includes("import { makeCommandCtx }"),
        'bot.ts imports makeCommandCtx',
    );
    assert.ok(
        botSrc.includes("makeCommandCtx('telegram'"),
        'bot.ts calls makeCommandCtx with telegram interface',
    );
});

// ─── CC-006: unified resetSkills (TG previously missing) ───

test('CC-006: resetSkills available in unified context', () => {
    assert.ok(
        ctxSrc.includes('resetSkills: async'),
        'resetSkills is defined in makeCommandCtx',
    );
    assert.ok(
        ctxSrc.includes('runSkillReset'),
        'resetSkills calls the centralized reset helper',
    );
});

// ─── CC-007: unified getPrompt ───

test('CC-007: getPrompt returns actual file content, not unsupported message', () => {
    assert.ok(
        ctxSrc.includes("fs.existsSync(A2_PATH)"),
        'getPrompt reads actual A2 file',
    );
    assert.ok(
        !ctxSrc.includes('tg.promptUnsupported'),
        'no unsupported message in unified context',
    );
});

test('CC-007b: skill CLI reset core avoids cwd-based repair', () => {
    assert.ok(
        !skillCmdSrc.includes('process.cwd()'),
        'skill CLI reset must not derive repair target from process.cwd()',
    );
    assert.ok(
        skillCmdSrc.includes('repairTargetDir: null'),
        'skill CLI reset must opt out of trusted-target repair',
    );
});

// ─── CC-008+: behavioral delegation tests ───

test('CC-008: telegram fallbackOrder patch delegates to applySettings', async () => {
    const calls: Record<string, any>[] = [];
    const ctx = makeCommandCtx('telegram', 'ko', {
        applySettings: async (patch: Record<string, any>) => {
            calls.push(patch);
            return { ok: true };
        },
        clearSession: () => undefined,
    });

    const result = await ctx.updateSettings({ fallbackOrder: ['codex', 'copilot'] });
    assert.equal(result?.ok, true);
    assert.deepEqual(calls, [{ fallbackOrder: ['codex', 'copilot'] }]);
});

test('CC-009: telegram rejects unsupported patches without calling applySettings', async () => {
    let calls = 0;
    const ctx = makeCommandCtx('telegram', 'ko', {
        applySettings: async () => {
            calls++;
            return { ok: true };
        },
        clearSession: () => undefined,
    });

    const result = await ctx.updateSettings({ workingDir: '/tmp/bad' });
    assert.equal(result?.ok, false);
    assert.equal(calls, 0);
});

test('CC-010: web context delegates settings patches directly', async () => {
    const calls: Record<string, any>[] = [];
    const ctx = makeCommandCtx('web', 'ko', {
        applySettings: async (patch: Record<string, any>) => {
            calls.push(patch);
            return { ok: true };
        },
        clearSession: () => undefined,
    });

    const result = await ctx.updateSettings({ cli: 'codex' });
    assert.equal(result?.ok, true);
    assert.deepEqual(calls, [{ cli: 'codex' }]);
});

test('CC-011: clearSession delegates to dependency callback', async () => {
    let cleared = 0;
    const ctx = makeCommandCtx('web', 'ko', {
        applySettings: async () => ({ ok: true }),
        clearSession: () => { cleared++; },
    });

    await ctx.clearSession();
    assert.equal(cleared, 1);
});

// ─── Phase 00: telegram settings allowlist expansion ───

test('CC-012: telegram allows cli settings patch', async () => {
    const calls: Record<string, any>[] = [];
    const ctx = makeCommandCtx('telegram', 'ko', {
        applySettings: async (patch: Record<string, any>) => { calls.push(patch); return { ok: true }; },
        clearSession: () => undefined,
    });
    const result = await ctx.updateSettings({ cli: 'codex' });
    assert.equal(result?.ok, true);
    assert.deepEqual(calls, [{ cli: 'codex' }]);
});

test('CC-013: telegram allows perCli settings patch', async () => {
    const calls: Record<string, any>[] = [];
    const ctx = makeCommandCtx('telegram', 'ko', {
        applySettings: async (patch: Record<string, any>) => { calls.push(patch); return { ok: true }; },
        clearSession: () => undefined,
    });
    const result = await ctx.updateSettings({ perCli: { claude: { model: 'claude-4-opus' } } });
    assert.equal(result?.ok, true);
    assert.deepEqual(calls, [{ perCli: { claude: { model: 'claude-4-opus' } } }]);
});

test('CC-014: telegram allows memory settings patch', async () => {
    const calls: Record<string, any>[] = [];
    const ctx = makeCommandCtx('telegram', 'ko', {
        applySettings: async (patch: Record<string, any>) => { calls.push(patch); return { ok: true }; },
        clearSession: () => undefined,
    });
    const result = await ctx.updateSettings({ memory: { cli: 'claude', model: 'default' } });
    assert.equal(result?.ok, true);
    assert.deepEqual(calls, [{ memory: { cli: 'claude', model: 'default' } }]);
});

test('CC-015: telegram rejects workingDir patch', async () => {
    let calls = 0;
    const ctx = makeCommandCtx('telegram', 'ko', {
        applySettings: async () => { calls++; return { ok: true }; },
        clearSession: () => undefined,
    });
    const result = await ctx.updateSettings({ workingDir: '/tmp/evil' });
    assert.equal(result?.ok, false);
    assert.equal(calls, 0);
});
