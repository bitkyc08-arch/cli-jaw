import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// C-6, boot path. A stored file carrying a PARTIAL ack is exactly the shape a
// shallow channel spread flattens: without the nested merge in config.ts the
// siblings come back missing rather than defaulted.
//
// Two module facts shape this file:
//   1. config.ts resolves JAW_HOME at IMPORT time, so CLI_JAW_HOME must be set
//      before the import and every case has to share one home.
//   2. the exported settings binding starts as createDefaultSettings(); only a
//      loadSettings() call commits a document, so each case rewrites the file
//      and loads again rather than re-importing.

const home = mkdtempSync(join(tmpdir(), 'jaw-ack-boot-'));
const settingsPath = join(home, 'settings.json');
process.env['CLI_JAW_HOME'] = home;

function writeSettings(doc: unknown): void {
    writeFileSync(settingsPath, JSON.stringify(doc));
}

async function loadFresh(): Promise<Record<string, any>> {
    const mod = await import('../../src/core/config.ts');
    return (mod as unknown as { loadSettings: () => Record<string, any> }).loadSettings();
}

test('boot merge fills a partial stored ack from defaults instead of dropping siblings', async () => {
    writeSettings({ slack: { enabled: true, botToken: 'xoxb-test', ack: { enabled: true } } });
    const merged = await loadFresh();
    const ack = merged['slack']?.ack;

    assert.ok(ack, 'slack.ack must exist after boot');
    assert.equal(ack.enabled, true, 'the stored value must win');
    assert.equal(ack.scope, 'group-mentions', 'an unmentioned sibling must come from defaults');
    assert.deepEqual(ack.emoji, {
        running: 'eyes',
        success: 'white_check_mark',
        failure: 'x',
        queued: 'hourglass_flowing_sand',
    }, 'the whole emoji group must survive a partial stored ack');
    assert.equal(ack.removeAfterReply, false);
});

test('unconfigured channels still receive their own vendor-shaped defaults', async () => {
    writeSettings({ slack: { enabled: true, botToken: 'xoxb-test', ack: { enabled: true } } });
    const merged = await loadFresh();
    // Telegram's allowlist has no white-check-mark, and Slack takes names rather
    // than unicode, so the three channels cannot share one default set.
    assert.equal(merged['telegram']?.ack?.emoji?.success, '\u{1F44D}');
    assert.equal(merged['discord']?.ack?.emoji?.success, '\u2705');
    assert.equal(merged['telegram']?.ack?.enabled, false, 'an unconfigured channel stays off');
});

test('a fully specified stored ack is preserved verbatim', async () => {
    writeSettings({
        slack: {
            enabled: true, botToken: 'xoxb-test',
            ack: {
                enabled: true, scope: 'all',
                emoji: { running: 'wave', success: 'tada', failure: 'boom', queued: 'zzz' },
                removeAfterReply: true,
            },
        },
    });
    const ack = (await loadFresh())['slack'].ack;
    assert.equal(ack.scope, 'all');
    assert.equal(ack.removeAfterReply, true);
    assert.deepEqual(ack.emoji, { running: 'wave', success: 'tada', failure: 'boom', queued: 'zzz' });
});

test('a stored file with no ack at all boots to defaults', async () => {
    writeSettings({ slack: { enabled: true, botToken: 'xoxb-test' } });
    const ack = (await loadFresh())['slack'].ack;
    assert.equal(ack.enabled, false);
    assert.equal(ack.scope, 'group-mentions');
    assert.equal(ack.emoji.running, 'eyes');
});
