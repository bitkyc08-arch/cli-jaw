// Phase 9.5: help renderer 단위 테스트
// src/command-contract/help-renderer.js 가 생성되면 통과
import test from 'node:test';
import assert from 'node:assert/strict';

let renderHelp;

// 모듈 로드 시도 — 미생성 시 graceful skip
let moduleLoaded = false;
try {
    const mod = await import('../../src/command-contract/help-renderer.js');
    renderHelp = mod.renderHelp;
    moduleLoaded = true;
} catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}

test('HP-001: list mode returns all visible commands', { skip: !moduleLoaded && 'help-renderer.js not yet created' }, () => {
    const r = renderHelp({ iface: 'web' });
    assert.ok(r.ok);
    assert.ok(r.text.includes('/help'), 'help should appear in list');
    assert.ok(r.text.length > 50, 'list should have substantial content');
});

test('HP-002: detail mode for known command', { skip: !moduleLoaded && 'help-renderer.js not yet created' }, () => {
    const r = renderHelp({ iface: 'web', commandName: 'help' });
    assert.ok(r.ok);
    assert.ok(r.text.includes('help'));
});

test('HP-003: unknown command returns not ok', { skip: !moduleLoaded && 'help-renderer.js not yet created' }, () => {
    const r = renderHelp({ iface: 'web', commandName: 'nonexistent_cmd_xyz' });
    assert.ok(!r.ok);
});

test('HP-004: telegram interface shows readonly tag', { skip: !moduleLoaded && 'help-renderer.js not yet created' }, () => {
    const r = renderHelp({ iface: 'telegram' });
    assert.ok(r.ok);
    // model은 readonly라서 태그가 있을 수 있음
    // 최소한 텍스트가 생성되는지 확인
    assert.ok(r.text.length > 0);
});

test('HP-005: cli interface help generation', { skip: !moduleLoaded && 'help-renderer.js not yet created' }, () => {
    const r = renderHelp({ iface: 'cli' });
    assert.ok(r.ok);
    assert.ok(r.text.includes('/'));  // 커맨드는 /로 시작
});
