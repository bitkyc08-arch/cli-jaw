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
// Validation-bearing runs use --skip-validate so the suite never needs Slack,
// and --no-notify so a REAL server on the default port is never PUT to.

const repoRoot = join(import.meta.dirname, '..', '..');
const cliEntry = join(repoRoot, 'bin', 'cli-jaw.ts');

type RunResult = { status: number; output: string; home: string };

function runSlack(
    args: string[],
    seedSettings?: Record<string, unknown>,
    extraEnv: Record<string, string> = {},
): RunResult {
    const home = mkdtempSync(join(homedir(), '.cljaw-test-'));
    if (seedSettings) {
        writeFileSync(join(home, 'settings.json'), JSON.stringify(seedSettings, null, 2));
    }
    const env = { ...process.env };
    for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_IDS']) delete env[key];
    Object.assign(env, extraEnv, { CLI_JAW_HOME: home });
    const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', cliEntry, 'slack', ...args],
        {
            env,
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
        'setup', '--non-interactive', '--skip-validate', '--no-notify',
        '--bot-token', 'xapp-1-abc', '--app-token', 'xoxb-1-abc',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 1);
    assert.match(output, /swap/i);
});

test('setup rejects an app token without the xapp- prefix', (t) => {
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate', '--no-notify',
        '--bot-token', 'xoxb-1-abc', '--app-token', 'xoxp-1-abc',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 1);
    assert.match(output, /xapp-/);
});

test('setup writes slack settings, preserves unrelated fields, never touches channel', (t) => {
    const seed = {
        messaging: { enabledChannels: ['telegram'], homeChannel: 'telegram' },
        slack: { enabled: false, mentionOnly: false, replyInThread: false, forwardAll: true },
    };
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate', '--no-notify',
        // Realistic length: the wizard now rejects a short app token as truncated,
        // which is what a partial copy out of Slack's scrolling field looks like.
        '--bot-token', 'xoxb-1-testbot', '--app-token', SAMPLE_APP_TOKEN,
        '--team-id', 'T123', '--channel-ids', 'C1, C2',
    ], seed);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 0, output);

    const s = readSettings(home);
    assert.equal(s.slack.enabled, true);
    assert.equal(s.slack.botToken, 'xoxb-1-testbot');
    assert.equal(s.slack.appToken, SAMPLE_APP_TOKEN);
    assert.equal(s.slack.teamId, 'T123');
    assert.deepEqual(s.slack.channelIds, ['C1', 'C2']);
    // One bot, one instance: the wizard claims the connection for the
    // configuring instance's port (default 3457 in a fresh home).
    assert.equal(s.slack.attachPort, '3457');
    // Fields the wizard does not own survive the merge.
    assert.equal(s.slack.mentionOnly, false);
    assert.equal(s.slack.replyInThread, false);
    // A two-token channel must never hijack the active channel.
    assert.equal(s.messaging.homeChannel, 'telegram');
    assert.deepEqual(s.messaging.enabledChannels, ['telegram']);
});

test('setup without an app token writes outbound-only with a warning', (t) => {
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate', '--no-notify', '--bot-token', 'xoxb-1-testbot',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 0, output);
    assert.match(output, /outbound only/i);
    const s = readSettings(home);
    assert.equal(s.slack.enabled, true);
    assert.equal(s.slack.appToken, '');
});

test('setup refuses to mix file credentials with an environment-managed connection', (t) => {
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate', '--no-notify', '--bot-token', 'xoxb-file-token',
    ], undefined, { SLACK_BOT_TOKEN: 'xoxb-environment-token' });
    t.after(() => rmSync(home, { recursive: true, force: true }));
    assert.equal(status, 1);
    assert.match(output, /managed by environment variables/i);
    const persisted = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, any>;
    assert.equal('botToken' in (persisted.slack || {}), false);
    assert.equal(JSON.stringify(persisted).includes('xoxb-environment-token'), false);
});

test('failed validation aborts before writing settings', (t) => {
    // The xoxb- prefix passes the local guard, so this reaches live auth.test,
    // which fails for a token Slack has never seen — and nothing is written.
    // This one case DOES hit the network; skip gracefully when offline.
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--no-notify', '--bot-token', 'xoxb-1-0000000000000-deadbeefdeadbeefdeadbeef',
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

// A realistic app-level token. Slack's are far longer than the placeholder this
// suite used to pass, and the wizard now treats a short one as a truncated copy.
const SAMPLE_APP_TOKEN = 'xapp-1-A012345678-1234567890123-' + 'a'.repeat(40);

test('setup rejects an app-level token that looks truncated (#396)', (t) => {
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate', '--no-notify',
        '--bot-token', 'xoxb-1-testbot', '--app-token', 'xapp-1-A0123',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));

    assert.notEqual(status, 0);
    assert.match(output, /truncated/i);
    // Slack answers a short token with a plain invalid_auth, which sends people off
    // regenerating a token that was never wrong. Say what actually happened instead.
    assert.match(output, /Copy button/i);
});

test('setup accepts a full-length app-level token', (t) => {
    const { status, output, home } = runSlack([
        'setup', '--non-interactive', '--skip-validate', '--no-notify',
        '--bot-token', 'xoxb-1-testbot', '--app-token', SAMPLE_APP_TOKEN,
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));

    assert.equal(status, 0, output);
    assert.equal(readSettings(home).slack.appToken, SAMPLE_APP_TOKEN);
});


test('manifest --url embeds the manifest Slack actually validates (#396)', (t) => {
    const { status, output, home } = runSlack(['manifest', '--url']);
    t.after(() => rmSync(home, { recursive: true, force: true }));

    assert.equal(status, 0, output);
    const url = output.trim().split('\n').filter(Boolean).at(-1)!;
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://api.slack.com/apps');
    assert.equal(parsed.searchParams.get('new_app'), '1');

    // The point of the flag: the page posts THIS parameter to
    // apps.manifest.validate, not whatever is in the editor. Pasting into a plain
    // ?new_app=1 page therefore validates {} and leaves Create disabled silently.
    const manifest = JSON.parse(parsed.searchParams.get('manifest_json') || 'null');
    assert.ok(manifest?.display_information?.name, 'display_information is the field Slack rejects {} for');
    assert.equal(manifest.settings.socket_mode_enabled, true);
});

