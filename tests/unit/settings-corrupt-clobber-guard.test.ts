import '../setup/isolated-home.ts';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    JAW_HOME, SETTINGS_PATH, loadSettings, saveSettings, settings,
    isSettingsPersistenceBlocked,
} from '../../src/core/config.ts';

// 260806 — a v2 packaged app read a v3 settings file, fell into the corrupt-file
// branch, and a later saveSettings flushed in-memory defaults over the user's real
// file (Slack tokens included). The latch under test here is the guarantee that an
// unreadable-but-existing settings.json is never overwritten by this process.

function writeSettings(doc: Record<string, unknown> | string): void {
    fs.mkdirSync(JAW_HOME, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf8');
}

function corruptBackups(): string[] {
    return fs.readdirSync(JAW_HOME).filter(name => name.startsWith('settings.json.corrupt-'));
}

afterEach(() => {
    try { fs.unlinkSync(SETTINGS_PATH); } catch { /* already gone */ }
    for (const name of corruptBackups()) {
        try { fs.unlinkSync(`${JAW_HOME}/${name}`); } catch { /* best effort */ }
    }
});

test('an unsupported-schema file latches persistence: saveSettings must not touch the file', () => {
    const original = JSON.stringify({
        settingsSchemaVersion: 99,
        cli: 'codex-app',
        slack: { enabled: true, botToken: 'xoxb-real-token' },
    });
    writeSettings(original);

    const s = loadSettings() as Record<string, any>;

    // Defaults in memory (pinned to the legacy meaning), and the latch is set.
    assert.equal(s["multiSession"].enabled, false);
    assert.equal(s["cli"], 'claude');
    assert.equal(isSettingsPersistenceBlocked(), true);
    assert.equal(corruptBackups().length, 1, 'the unreadable file was backed up');

    // The clobber path: any later save (messaging.latestSeen, a UI write) flushes the
    // in-memory defaults. While latched it must commit to memory only.
    settings["locale"] = 'en';
    saveSettings(settings);

    assert.equal(fs.readFileSync(SETTINGS_PATH, 'utf8'), original,
        'the user\'s real settings file must survive the save untouched');
    assert.equal(settings["locale"], 'en', 'the save still lands in memory');
});

test('corrupt JSON latches the same way', () => {
    writeSettings('{ this is not json');
    loadSettings();
    assert.equal(isSettingsPersistenceBlocked(), true);
    saveSettings(settings);
    assert.equal(fs.readFileSync(SETTINGS_PATH, 'utf8'), '{ this is not json');
});

test('a readable file clears the latch on the next load', () => {
    writeSettings('{ this is not json');
    loadSettings();
    assert.equal(isSettingsPersistenceBlocked(), true);

    fs.unlinkSync(SETTINGS_PATH);
    // ENOENT is a genuinely new install (or a recreated home) and must keep
    // persisting as before — the latch belongs only to the unreadable-file case.
    loadSettings();
    assert.equal(isSettingsPersistenceBlocked(), false);
    assert.ok(fs.existsSync(SETTINGS_PATH), 'the ENOENT branch still writes a fresh file');
});
