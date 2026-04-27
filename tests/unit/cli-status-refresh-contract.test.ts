import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('CLI status interval setting drives automatic refresh scheduling', () => {
    const status = read('public/js/features/settings-cli-status.ts');
    const main = read('public/js/main.ts');
    const html = read('public/index.html');

    assert.ok(html.includes('id="cliStatusInterval"'), 'CLI status interval select must exist');
    assert.ok(!html.includes('value="60"'), 'CLI status interval must not expose 1 minute');
    assert.ok(!html.includes('value="300"'), 'CLI status interval must not expose 5 minutes');
    assert.ok(!html.includes('time.1m'), 'CLI status interval must not keep 1 minute i18n wiring');
    assert.ok(!html.includes('time.5m'), 'CLI status interval must not keep 5 minute i18n wiring');
    assert.ok(html.includes('value="600"'), 'CLI status interval must expose 10 minutes');
    assert.ok(!html.includes('value="1800" selected'), 'CLI status interval must not default to 30 minutes');
    assert.ok(html.includes('data-i18n="time.30m"'), 'CLI status interval must localize 30 minutes');
    assert.ok(html.includes('value="0" selected'), 'CLI status interval must default to manual mode');

    assert.ok(status.includes('CLI_STATUS_INTERVAL_VALUES = new Set([0, 600, 1800])'), 'scheduler must allow only manual, 10 minutes, and 30 minutes');
    assert.ok(status.includes('DEFAULT_CLI_STATUS_INTERVAL_SEC = 0'), 'scheduler default must be manual');
    assert.ok(status.includes('scheduleCliStatusRefresh'), 'settings-cli-status must export an auto refresh scheduler');
    assert.ok(status.includes('window.setInterval'), 'scheduler must install a timer');
    assert.ok(status.includes('document.hidden || !document.hasFocus()'), 'scheduler must skip refresh while the Chrome tab/window is inactive');
    assert.ok(status.includes('loadCliStatus(true)'), 'timer must force a fresh status/quota refresh');
    assert.ok(status.includes('window.clearInterval'), 'scheduler must clear the previous timer');
    assert.ok(status.includes('interval <= 0'), 'manual mode must disable the timer');
    assert.ok(status.includes('setCliStatusInterval'), 'change handler must persist and reschedule the interval');

    assert.ok(main.includes('scheduleCliStatusRefresh()'), 'bootstrap must start CLI status auto refresh');
    assert.ok(main.includes('setCliStatusInterval(this.value)'), 'select changes must reschedule auto refresh');
});
