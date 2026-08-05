import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettingsMetadata } from '../../src/manager/metadata.ts';

// 072 §1.4 — the manager cannot offer a session tree for an instance whose
// multi-session flag it throws away during the scan.

test('the multi-session flag survives the settings normalization', () => {
    const on = normalizeSettingsMetadata({ data: { multiSession: { enabled: true } } });
    assert.equal(on.multiSession, true);

    const off = normalizeSettingsMetadata({ data: { multiSession: { enabled: false } } });
    assert.equal(off.multiSession, false);
});

test('it reads the flag from an unwrapped settings body too', () => {
    assert.equal(normalizeSettingsMetadata({ multiSession: { enabled: true } }).multiSession, true);
});

// An instance old enough not to report the flag has no session list to expand, so
// reading it as single-session is the correct answer rather than a missing one.
test('a missing or malformed flag reads as single-session', () => {
    for (const body of [{}, { data: {} }, { data: { multiSession: null } }, { data: { multiSession: 'yes' } }, { data: { multiSession: { enabled: 'true' } } }, null]) {
        assert.equal(normalizeSettingsMetadata(body).multiSession, false, `${JSON.stringify(body)} must read as off`);
    }
});

test('the other metadata fields still come through unchanged', () => {
    const metadata = normalizeSettingsMetadata({
        data: { workingDir: '/tmp/work', cli: 'codex', model: 'gpt-5.5', multiSession: { enabled: true } },
    });
    assert.equal(metadata.workingDir, '/tmp/work');
    assert.equal(metadata.currentCli, 'codex');
    assert.equal(metadata.currentModel, 'gpt-5.5');
    assert.equal(metadata.multiSession, true);
});
