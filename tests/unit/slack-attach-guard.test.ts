// channel-health surfaces the attach guard: tokens present but this
// instance is not the attach instance → not_attach_instance, not "broken".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(homedir(), '.cljaw-test-'));
process.env['CLI_JAW_HOME'] = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

writeFileSync(join(home, 'settings.json'), JSON.stringify({
    channel: 'slack',
    port: '24575',
    slack: {
        enabled: true,
        botToken: 'xoxb-1-test',
        appToken: 'xapp-1-test',
        channelIds: ['C1'],
        attachPort: '',
    },
}, null, 2));

const { getTransportCapability } = await import('../../src/messaging/channel-health.ts');
const { loadSettings } = await import('../../src/core/config.ts');
loadSettings();

test('an unset owner reports not_attach_instance until init elects one', () => {
    const cap = getTransportCapability('slack');
    assert.equal(cap.reason, 'not_attach_instance');
    assert.equal(cap.configured, true);
    assert.equal(cap.activeInbound, false);
    assert.equal(cap.sendCapable, false);
});
test('a different elected port reports not_attach_instance', async () => {
    const { settings, saveSettings } = await import('../../src/core/config.ts');
    settings["slack"].attachPort = '3457';
    saveSettings(settings);
    assert.equal(getTransportCapability('slack').reason, 'not_attach_instance');
});
test('the elected instance reports normally', async () => {
    const { settings, saveSettings } = await import('../../src/core/config.ts');
    settings["slack"].attachPort = '24575';
    saveSettings(settings);
    assert.notEqual(getTransportCapability('slack').reason, 'not_attach_instance');
});
