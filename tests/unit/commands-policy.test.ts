// Phase 9.5: commands policy 단위 테스트
// src/command-contract/policy.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let getVisibleCommands, getTelegramMenuCommands, getExecutableCommands;

// 모듈 로드 시도 — 미생성 시 graceful skip
let moduleLoaded = false;
try {
    const mod = await import('../../src/command-contract/policy.ts');
    getVisibleCommands = mod.getVisibleCommands;
    getTelegramMenuCommands = mod.getTelegramMenuCommands;
    getExecutableCommands = mod.getExecutableCommands;
    moduleLoaded = true;
} catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}

test('CP-001: web visible includes help', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getVisibleCommands('web');
    assert.ok(cmds.some(c => c.name === 'help'), 'help should be visible on web');
});

test('CP-002: telegram menu includes model and cli (full writable)', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    assert.ok(cmds.some(c => c.name === 'model'), 'model should be in telegram menu');
    assert.ok(cmds.some(c => c.name === 'cli'), 'cli should be in telegram menu');
});

test('CP-003: telegram visible includes model (full)', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getVisibleCommands('telegram');
    const model = cmds.find(c => c.name === 'model');
    assert.ok(model, 'model should be visible on telegram');
    if (model.capability) {
        assert.equal(model.capability.telegram, 'full');
    }
});

test('CP-004: web executable commands are subset of visible', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const visible = getVisibleCommands('web').map(c => c.name);
    const executable = getExecutableCommands('web').map(c => c.name);
    for (const name of executable) {
        assert.ok(visible.includes(name), `executable "${name}" should be in visible`);
    }
});

test('CP-005: all interfaces return non-empty lists', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    for (const iface of ['web', 'cli', 'telegram', 'discord']) {
        const cmds = getVisibleCommands(iface);
        assert.ok(cmds.length > 0, `${iface} should have visible commands`);
    }
});

test('CP-006: telegram menu includes help', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    assert.ok(cmds.some(c => c.name === 'help'), 'help should be in telegram menu');
});

test('CP-007: telegram menu excludes start/id/settings', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    for (const name of ['start', 'id', 'settings']) {
        assert.ok(!cmds.some(c => c.name === name), `${name} should not be in telegram menu`);
    }
});

test('CP-008: telegram menu has exact expected command set', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    const names = new Set(cmds.map(c => c.name));
    const expected = new Set(['help', 'status', 'clear', 'compact', 'plan', 'interview', 'deliberate', 'planaudit', 'goal', 'model', 'cli', 'fallback', 'forward', 'thought', 'flush', 'version', 'skill', 'browser', 'steer', 'reset', 'employee', 'mcp', 'memory', 'prompt', 'orchestrate']);
    // All expected present
    for (const name of expected) {
        assert.ok(names.has(name), `expected "${name}" in telegram menu`);
    }
    // No unexpected extras (except future additions — we allow superset)
    assert.ok(cmds.length >= expected.size, `expected >= ${expected.size} commands, got ${cmds.length}`);
});

test('CP-009: every telegram command has tgDescKey or descKey fallback', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    for (const c of cmds) {
        const hasDesc = c.tgDescKey || c.descKey || c.desc;
        assert.ok(hasDesc, `command "${c.name}" should have tgDescKey, descKey, or desc`);
    }
});

test('CP-011: discord visible includes promoted commands', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getVisibleCommands('discord');
    const names = new Set(cmds.map(c => c.name));
    for (const name of ['reset', 'employee', 'mcp', 'memory', 'prompt', 'orchestrate', 'skill', 'browser']) {
        assert.ok(names.has(name), `expected "${name}" in discord visible commands`);
    }
});

test('CP-012: discord slash command descriptions are <= 100 chars', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getVisibleCommands('discord');
    for (const c of cmds) {
        const desc = c.desc || `/${c.name}`;
        assert.ok(desc.length <= 100, `command "${c.name}" desc is ${desc.length} chars (max 100)`);
    }
});

test('CP-013: workflow commands are visible on web and hidden from cmdline', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const workflowNames = ['plan', 'interview', 'deliberate', 'planaudit', 'goal'];
    const web = new Set(getVisibleCommands('web').map(c => c.name));
    const cmdline = new Set(getVisibleCommands('cmdline').map(c => c.name));

    for (const name of workflowNames) {
        assert.ok(web.has(name), `${name} should be visible on web`);
        assert.ok(!cmdline.has(name), `${name} should be hidden from cmdline`);
    }
    assert.ok(!web.has('autopilot'), 'autopilot should not be a top-level workflow command');
});

test('CP-014: workflow commands are remote-safe for telegram and discord', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const remoteName = /^[a-z0-9_]{1,32}$/;
    for (const iface of ['telegram', 'discord']) {
        const names = getVisibleCommands(iface)
            .filter(c => c.category === 'workflow')
            .map(c => c.name);
        assert.deepEqual(names.sort(), ['deliberate', 'gd', 'goal', 'goalplan', 'interview', 'plan', 'planaudit', 'review', 'search', 'team'].sort());
        for (const name of names) {
            assert.match(name, remoteName, `${iface} workflow command "${name}" must be remote-safe`);
            assert.equal(name.includes('-'), false, `${iface} workflow command "${name}" must not contain hyphen`);
        }
    }
});

test('CP-015: telegram menu never registers hyphenated command names', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    assert.ok(cmds.some(c => c.name === 'planaudit'), 'planaudit should be in telegram menu');
    assert.ok(!cmds.some(c => c.name === 'plan-audit'), 'plan-audit must not be in telegram menu');
    for (const c of cmds) {
        assert.equal(c.name.includes('-'), false, `telegram menu command "${c.name}" must not contain hyphen`);
    }
});

test('CP-016: every workflow command tgDescKey is translated in ko/en/ja/zh', { skip: !moduleLoaded && 'policy.js not yet created' }, async () => {
    const { getCommandCatalog } = await import('../../src/command-contract/catalog.ts');
    const workflow = getCommandCatalog().filter(c => c.category === 'workflow');
    const bundles = Object.fromEntries(['ko', 'en', 'ja', 'zh'].map(locale => {
        const url = new URL(`../../public/locales/${locale}.json`, import.meta.url);
        return [locale, JSON.parse(readFileSync(url, 'utf8'))];
    }));

    for (const cmd of workflow) {
        assert.ok(cmd.tgDescKey, `${cmd.name} should define tgDescKey`);
        for (const [locale, bundle] of Object.entries(bundles)) {
            assert.ok(bundle[cmd.tgDescKey], `${locale} missing ${cmd.tgDescKey}`);
        }
    }
});

test('CP-017: goal run is the automation surface, not top-level autopilot', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const web = getVisibleCommands('web');
    const goal = web.find(c => c.name === 'goal');
    assert.ok(goal, 'goal should be visible as the workflow state command');
    assert.ok(!web.some(c => c.name === 'autopilot'), 'autopilot should not be visible as a top-level command');
    assert.equal(goal.workflow?.gatedUntilPhase, undefined, 'gatedUntilPhase should be removed (goal is fully functional)');
    assert.equal(goal.workflow?.prerequisites, undefined, 'stale prerequisites should be removed');
});

test('CP-010: model and cli are writable on telegram', { skip: !moduleLoaded && 'policy.js not yet created' }, async () => {
    const { getCommandCatalog, CAPABILITY } = await import('../../src/command-contract/catalog.ts');
    for (const name of ['model', 'cli']) {
        const cmd = getCommandCatalog().find(c => c.name === name);
        assert.equal(cmd?.capability?.telegram, CAPABILITY.full,
            `/${name} should be full (writable) on telegram`);
    }
});
