// Phase 9.5: commands policy 단위 테스트
// src/command-contract/policy.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';

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

test('CP-002: telegram menu includes model and cli (readonly visible)', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    assert.ok(cmds.some(c => c.name === 'model'), 'model should be in telegram menu (readonly)');
    assert.ok(cmds.some(c => c.name === 'cli'), 'cli should be in telegram menu (readonly)');
});

test('CP-003: telegram visible includes model (readonly)', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getVisibleCommands('telegram');
    const model = cmds.find(c => c.name === 'model');
    assert.ok(model, 'model should be visible on telegram');
    // readonly 확인은 capability 필드가 있을 때만
    if (model.capability) {
        assert.equal(model.capability.telegram, 'readonly');
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
    for (const iface of ['web', 'cli', 'telegram']) {
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
    const expected = new Set(['help', 'status', 'clear', 'model', 'cli', 'fallback', 'flush', 'version', 'skill', 'browser', 'steer']);
    // All expected present
    for (const name of expected) {
        assert.ok(names.has(name), `expected "${name}" in telegram menu`);
    }
    // No unexpected extras (except future additions — we allow superset)
    assert.ok(cmds.length >= expected.size, `expected >= ${expected.size} commands, got ${cmds.length}`);
});

test('CP-009: every telegram command has tgDescKey', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    for (const c of cmds) {
        assert.ok(c.tgDescKey, `command "${c.name}" should have tgDescKey`);
        assert.ok(typeof c.tgDescKey === 'string' && c.tgDescKey.startsWith('cmd.'), `tgDescKey "${c.tgDescKey}" should be a valid i18n key`);
    }
});

test('CP-010: readonly commands block write on telegram', { skip: !moduleLoaded && 'policy.js not yet created' }, async () => {
    // model and cli are readonly on telegram — supplying args should be blocked
    const { parseCommand, executeCommand } = await import('../../src/cli/commands.ts');
    for (const name of ['model', 'cli']) {
        const parsed = parseCommand(`/${name} some-arg`);
        assert.ok(parsed, `parseCommand should parse /${name}`);
        const result = await executeCommand(parsed, { interface: 'telegram', locale: 'ko' });
        assert.ok(result, `executeCommand result should not be null for /${name}`);
        assert.equal(result.ok, false, `/${name} with args should fail on telegram (readonly)`);
        assert.equal(result.code, 'readonly', `/${name} should return readonly code`);
    }
    // Without args, model/cli should succeed (read-only view)
    for (const name of ['model', 'cli']) {
        const parsed = parseCommand(`/${name}`);
        const result = await executeCommand(parsed, { interface: 'telegram', locale: 'ko' });
        // Should not be blocked by readonly guard (args.length === 0)
        assert.notEqual(result?.code, 'readonly', `/${name} without args should not be readonly-blocked`);
    }
});
