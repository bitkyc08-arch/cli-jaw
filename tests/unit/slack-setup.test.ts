import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

/**
 * Shadow the macOS conveniences `jaw slack setup` shells out to, recording
 * each call. Used to prove a headless run launches neither (#475) — and that a
 * terminal run still does — without a real browser window opening on whoever
 * runs the suite. Neither stub reads stdin: execFile leaves that pipe open, so
 * a stub blocking on it would outlive the wizard and hang the test.
 */
function writeLauncherStubs(dir: string, logPath: string): void {
    for (const name of ['open', 'pbcopy']) {
        const p = join(dir, name);
        writeFileSync(p, `#!/bin/sh\necho "${name}" >> "${logPath}"\nexit 0\n`);
        chmodSync(p, 0o755);
    }
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

// ---------------------------------------------------------------------------
// #475 — setup must not prompt when there is no terminal to answer.
//
// Every case above already runs with stdin ignored, but each one also passes
// --non-interactive, so they only ever exercised the flag. Without it the
// wizard used to build a readline interface anyway and await an answer that a
// closed or piped stdin can never produce. The promise never settles, so it is
// not throwable and not catchable: node prints "unsettled top-level await" and
// exits 13, leaving the validated tokens unwritten.
// ---------------------------------------------------------------------------

test('setup completes over a non-TTY stdin without --non-interactive (#475)', (t) => {
    // The reproduction from the issue: flags supply every value, stdin is
    // /dev/null, and no --non-interactive. This used to exit 13 at the Step 1
    // "Press Enter" wait.
    const { status, output, home } = runSlack([
        'setup', '--skip-validate', '--no-notify',
        '--bot-token', 'xoxb-1-testbot', '--app-token', SAMPLE_APP_TOKEN, '--team-id', 'T123',
    ]);
    t.after(() => rmSync(home, { recursive: true, force: true }));

    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /unsettled top-level await/i);
    // The point of the bug: the run "finished" without persisting anything.
    const s = readSettings(home);
    assert.equal(s.slack.enabled, true);
    assert.equal(s.slack.botToken, 'xoxb-1-testbot');
    assert.equal(s.slack.appToken, SAMPLE_APP_TOKEN);
    assert.equal(s.slack.teamId, 'T123');
});

test('setup skips the Press-Enter wait and browser launch without a TTY (#475)', (t) => {
    // The old guard read the flag only, so a plain piped run still shelled out
    // to `open` and threw a browser window at whoever ran it — on a host with
    // no terminal attached, that is pure noise nobody asked for. PATH is
    // shadowed with recording stubs so the assertion is about the syscall, not
    // about a log line that might merely have been silenced.
    const stubs = mkdtempSync(join(homedir(), '.cljaw-stub-'));
    t.after(() => rmSync(stubs, { recursive: true, force: true }));
    const stubLog = join(stubs, 'calls.log');
    writeLauncherStubs(stubs, stubLog);
    const { status, output, home } = runSlack(
        ['setup', '--skip-validate', '--no-notify', '--bot-token', 'xoxb-1-testbot'],
        undefined,
        { PATH: `${stubs}:${process.env.PATH ?? ''}` },
    );
    t.after(() => rmSync(home, { recursive: true, force: true }));

    assert.equal(status, 0, output);
    // The manifest and URL still print — they are the actionable output. Only
    // the prompt and the macOS conveniences are suppressed.
    assert.match(output, /api\.slack\.com\/apps/);
    assert.doesNotMatch(output, /Press Enter once the app is created/);
    assert.doesNotMatch(output, /copied to clipboard/i);
    assert.equal(existsSync(stubLog), false, 'a headless run must not launch a browser or touch the clipboard');
});

test('a non-TTY run still refuses to write without a bot token (#475)', (t) => {
    // Not prompting must not mean accepting less. The crash is gone; the
    // requirement is not relaxed, and the message names the flag to use.
    const { status, output, home } = runSlack(['setup', '--skip-validate', '--no-notify']);
    t.after(() => rmSync(home, { recursive: true, force: true }));

    assert.equal(status, 1);
    assert.match(output, /A bot token is required/);
    assert.match(output, /--bot-token/);
    const persisted = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, any>;
    assert.notEqual(persisted.slack?.enabled, true);
});

test('setup still prompts when stdin is a TTY (#475)', async (t) => {
    // The other half of the guard: a terminal must still get the wizard.
    //
    // isTTY is forced by a preload rather than opened with `script`, whose
    // flags differ between BSD and GNU. Two consequences shape this setup.
    // readline in terminal mode drains the pipe on its first read, so only
    // the FIRST prompt can be answered — every other value is passed as a
    // flag, including an explicit empty --app-token, which leaves exactly one
    // question. And the answer must be written only AFTER that question is on
    // screen, since anything sent earlier is swallowed by the manifest
    // printing above it.
    //
    // PATH is shadowed so the macOS conveniences hit recording stubs: a test
    // must never actually open a browser. The `open` stub must not read stdin
    // either — execFile leaves that pipe open, and a stub that blocks on it
    // keeps the child alive after the wizard is done.
    const home = mkdtempSync(join(homedir(), '.cljaw-test-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const stubs = mkdtempSync(join(homedir(), '.cljaw-stub-'));
    t.after(() => rmSync(stubs, { recursive: true, force: true }));
    const stubLog = join(stubs, 'calls.log');
    writeLauncherStubs(stubs, stubLog);

    const env = { ...process.env };
    for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_IDS']) delete env[key];
    env.CLI_JAW_HOME = home;
    env.PATH = `${stubs}:${process.env.PATH ?? ''}`;

    const forceTty = pathToFileURL(join(repoRoot, 'tests', 'fixtures', 'force-tty-stdin.mts')).href;
    const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--import', forceTty, cliEntry,
            'slack', 'setup', '--skip-validate', '--no-notify',
            '--bot-token', 'xoxb-1-ttybot', '--app-token', '', '--channel-ids', 'C9'],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let answered = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (!answered && /Press Enter once the app is created/.test(output)) {
            answered = true;
            child.stdin.end('\n');
        }
    });
    const status = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`setup never exited on a TTY; output so far:\n${output}`));
        }, 45_000);
        child.on('error', reject);
        child.on('close', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    });

    assert.equal(status, 0, output);
    // The prompt the non-TTY path skips is present here.
    assert.match(output, /Press Enter once the app is created/);
    assert.doesNotMatch(output, /unsettled top-level await/i);
    assert.equal(readSettings(home).slack.botToken, 'xoxb-1-ttybot');
    // ...and on a terminal the macOS conveniences DO fire, which is the
    // behaviour the non-TTY test asserts is suppressed.
    if (process.platform === 'darwin') {
        assert.match(readFileSync(stubLog, 'utf8'), /open/);
    }
});
