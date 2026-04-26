import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SETTINGS_CORE = path.join(ROOT, 'public/js/features/settings-core.ts');
const CHAT = path.join(ROOT, 'public/js/features/chat.ts');

const settingsSrc = fs.readFileSync(SETTINGS_CORE, 'utf8');
const chatSrc = fs.readFileSync(CHAT, 'utf8');

test('SSR-001: settings-core tracks active settings save promise', () => {
    assert.match(settingsSrc, /let\s+activeSettingsSave:\s*Promise<void>\s*\|\s*null\s*=\s*null/);
    assert.match(settingsSrc, /function\s+trackSettingsSave\(/);
    assert.match(settingsSrc, /activeSettingsSave\s*=\s*tracked/);
});

test('SSR-002: settings-core exports waitForSettingsSaveIdle', () => {
    assert.match(settingsSrc, /export\s+async\s+function\s+waitForSettingsSaveIdle\(\):\s*Promise<void>/);
    assert.match(settingsSrc, /const\s+pending\s*=\s*activeSettingsSave/);
    assert.match(settingsSrc, /if\s*\(\s*pending\s*\)\s*await\s+pending/);
});

test('SSR-003: updateSettings restores confirmed server state on failure', () => {
    assert.match(settingsSrc, /const\s+result\s*=\s*await\s+apiJson<SettingsData>\('\/api\/settings',\s*'PUT',\s*s\)/);
    assert.match(settingsSrc, /if\s*\(\s*!result\s*\)\s*\{[\s\S]*await\s+loadSettings\(\);[\s\S]*return;[\s\S]*\}/);
    assert.match(settingsSrc, /const\s+confirmedCli\s*=\s*result\.cli\s*\|\|\s*s\.cli/);
    assert.match(settingsSrc, /setHeaderCli\(confirmedCli\)/);
});

test('SSR-004: chat waits for pending settings save before sending message', () => {
    assert.match(chatSrc, /import\s+\{\s*waitForSettingsSaveIdle\s*\}\s+from\s+['"]\.\/settings-core\.js['"]/);
    const waitIdx = chatSrc.indexOf('await waitForSettingsSaveIdle()');
    assert.ok(waitIdx > -1, 'chat must wait for pending settings save');

    const sendPoints = [
        ["fetch('/api/command'", 'slash command POST'],
        ["apiJson('/api/message', 'POST', { prompt: text })", 'slash not_command fallback message POST'],
        ["apiJson('/api/message', 'POST', { prompt })", 'file attachment message POST'],
        ["fetch('/api/message'", 'normal message POST'],
    ] as const;

    for (const [needle, label] of sendPoints) {
        const sendIdx = chatSrc.indexOf(needle);
        assert.ok(sendIdx > -1, `${label} should exist`);
        assert.ok(sendIdx > waitIdx, `${label} must happen after settings wait`);
    }
});
