/**
 * #379 regression: bin/commands/service.ts accepted backend 'windows' but had
 * no dispatch branch, so Windows fell through into the systemd tail and
 * crashed on sudo. The command file is a top-level script whose backend is
 * derived from process.platform at load, so these are structural asserts on
 * the dispatch shape rather than a cross-platform subprocess run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../bin/commands/service.ts', import.meta.url), 'utf8');

test('SWB-001: a windows dispatch branch exists', () => {
    assert.match(src, /if \(backend === 'windows'\)/);
});

test('SWB-002: the windows branch delegates to platform-service lifecycle', () => {
    assert.match(src, /await permInstance\(portNum, JAW_HOME\)/);
    assert.match(src, /await unpermInstance\(portNum, JAW_HOME\)/);
});

test('SWB-003: the systemd tail is guarded against fall-through', () => {
    const guard = src.indexOf("if (backend !== 'systemd')");
    const tail = src.indexOf('/etc/systemd/system/');
    assert.ok(guard !== -1, 'systemd guard missing');
    assert.ok(tail !== -1, 'systemd tail moved; update this test');
    assert.ok(guard < tail, 'guard must run before the systemd tail');
});

test('SWB-004: --backend windows is rejected off-platform', () => {
    assert.match(src, /opts\.backend === 'windows' && process\.platform !== 'win32'/);
});
