// settings.json carries live channel tokens — it must be owner-only.
// CLI_JAW_HOME must be set BEFORE importing config (paths bind at import).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(homedir(), '.cljaw-test-'));
process.env['CLI_JAW_HOME'] = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { saveSettings, loadSettings, SETTINGS_PATH } = await import('../../src/core/config.ts');

const isWin = platform() === 'win32';

test('saveSettings writes settings.json with 0600', { skip: isWin }, () => {
    saveSettings({ cli: 'codex' });
    const mode = statSync(SETTINGS_PATH).mode & 0o777;
    assert.equal(mode, 0o600, `expected 600, got ${mode.toString(8)}`);
});

test('saveSettings tightens an existing loose file', { skip: isWin }, () => {
    chmodSync(SETTINGS_PATH, 0o644);
    saveSettings({ cli: 'codex', again: true });
    const mode = statSync(SETTINGS_PATH).mode & 0o777;
    assert.equal(mode, 0o600);
});

test('loadSettings heals a hand-loosened 0644 file', { skip: isWin }, () => {
    writeFileSync(SETTINGS_PATH, JSON.stringify({ cli: 'codex' }, null, 2));
    chmodSync(SETTINGS_PATH, 0o644);
    loadSettings();
    const mode = statSync(SETTINGS_PATH).mode & 0o777;
    assert.equal(mode, 0o600, 'load must heal loose permissions (tokens inside)');
});
