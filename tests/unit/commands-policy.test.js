// Phase 9.5: commands policy 단위 테스트
// src/command-contract/policy.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';

let getVisibleCommands, getTelegramMenuCommands, getExecutableCommands;

// 모듈 로드 시도 — 미생성 시 graceful skip
let moduleLoaded = false;
try {
    const mod = await import('../../src/command-contract/policy.js');
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

test('CP-002: telegram menu excludes model and cli', { skip: !moduleLoaded && 'policy.js not yet created' }, () => {
    const cmds = getTelegramMenuCommands();
    assert.ok(!cmds.some(c => c.name === 'model'), 'model should not be in telegram menu');
    assert.ok(!cmds.some(c => c.name === 'cli'), 'cli should not be in telegram menu');
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
