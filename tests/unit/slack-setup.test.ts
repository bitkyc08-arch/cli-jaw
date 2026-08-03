import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

// BEHAVIOR tests for `jaw slack manifest|setup`, following the
// slack-init-behavior.test.ts pattern: run the real CLI in an isolated
// CLI_JAW_HOME under the user home and read back what it wrote.
// Validation-bearing runs use --skip-validate so the suite never needs Slack.

const repoRoot = join(import.meta.dirname, '..', '..');
const cliEntry = join(repoRoot, 'bin', 'cli-jaw.ts');

type RunResult = { status: number; output: string; home: string };

function runSlack(args: string[], seedSettings?: Record<string, unknown>): RunResult {
    const home = mkdtempSync(join(homedir(), '.cljaw-test-'));
    if (seedSettings) {
        writeFileSync(join(home, 'settings.json'), JSON.stringify(seedSettings, null, 2));
    }
    const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', cliEntry, 'slack', ...args],
        {
            env: { ...process.env, CLI_JAW_HOME: home },
            encoding: 'utf8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    return {
        status: result.status ?? 1,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
        home,
    };
}

function readSettings(home: string): Record<string, any> {
    const p = join(home, 'settings.json');
    assert.ok(existsSync(p), 'settings.json should exist after setup');
    return JSON.parse(readFileSync(p, 'utf8'));
}

test('slack manifest emits the parseable manifest with socket mode on', (t) => {
    const { status, output, home } = runSlack(['manifest']);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 0, output);
    const manifest = parse(output);
    assert.equal(manifest.settings.socket_mode_enabled, true);
    assert.ok(manifest.oauth_config.scopes.bot.includes('chat:write'));
    assert.ok(manifest.settings.event_subscriptions.bot_events.includes('message.im'));
});

test('setup rejects a bot token without the xoxb- prefix', (t) => {
    const { status, output, home } = runSlack(['setup', '--non-interactive', '--bot-token', 'not-a-token']);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 1);
    assert.match(output, /xoxb-/);
});

test('setup catches swapped tokens (xapp- in the bot slot)', (t) => {
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate',
        '--bot-token', 'xapp-1-abc', '--app-token', 'xoxb-1-abc',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 1);
    assert.match(output, /swap/i);
});

test('setup rejects an app token without the xapp- prefix', (t) => {
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate',
        '--bot-token', 'xoxb-1-abc', '--app-token', 'xoxp-1-abc',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 1);
    assert.match(output, /xapp-/);
});

test('setup writes slack settings, preserves unrelated fields, never touches channel', (t) => {
    const seed = {
        channel: 'telegram',
        slack: { enabled: false, mentionOnly: false, replyInThread: false, forwardAll: true },
    };
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate',
        '--bot-token', 'xoxb-1-testbot', '--app-token', 'xapp-1-testapp',
        '--team-id', 'T123', '--channel-ids', 'C1, C2',
    ], seed);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 0, output);

    const s = readSettings(home);
    assert.equal(s.slack.enabled, true);
    assert.equal(s.slack.botToken, 'xoxb-1-testbot');
    assert.equal(s.slack.appToken, 'xapp-1-testapp');
    assert.equal(s.slack.teamId, 'T123');
    assert.deepEqual(s.slack.channelIds, ['C1', 'C2']);
    // Fields the wizard does not own survive the merge.
    assert.equal(s.slack.mentionOnly, false);
    assert.equal(s.slack.replyInThread, false);
    // A two-token channel must never hijack the active channel.
    assert.equal(s.channel, 'telegram');
});

test('setup without an app token writes outbound-only with a warning', (t) => {
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate', '--bot-token', 'xoxb-1-testbot',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 0, output);
    assert.match(output, /outbound only/i);
    const s = readSettings(home);
    assert.equal(s.slack.enabled, true);
    assert.equal(s.slack.appToken, '');
});

test('failed validation aborts before writing settings', (t) => {
    // The xoxb- prefix passes the local guard, so this reaches live auth.test,
    // which fails for a token Slack has never seen — and nothing is written.
    // This one case DOES hit the network; skip gracefully when offline.
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--bot-token', 'xoxb-1-0000000000000-deadbeefdeadbeefdeadbeef',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(output)) {
        t.skip('offline: live validation path untestable');
        return;
    }
    assert.equal(status, 1);
    assert.match(output, /auth\.test failed/);
    // Note: loadSettings() itself persists defaults on ENOENT, so "nothing
    // written" means no SLACK state — not a missing file.
    const s = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.ok(!s.slack?.botToken, 'bot token must not be persisted after failed validation');
    assert.notEqual(s.slack?.enabled, true);
});
