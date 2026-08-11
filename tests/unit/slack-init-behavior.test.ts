import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// BEHAVIOR tests for the operator setup path. The sibling
// slack-operator-tooling.test.ts asserts on source text, which cannot tell
// whether a flag is actually honoured; these run the real CLI in an isolated
// home and read back the settings file it writes.
//
// The CLI refuses a JAW_HOME outside the user's home directory, so the
// sandbox lives under ~ and is removed afterwards.

const repoRoot = join(import.meta.dirname, '..', '..');
const cliEntry = join(repoRoot, 'bin', 'cli-jaw.ts');

type RunResult = { status: number; output: string; settings: Record<string, unknown> | null };

function runInit(args: string[], extraEnv: Record<string, string> = {}): RunResult {
    const home = mkdtempSync(join(homedir(), '.cljaw-test-'));
    try {
        // spawnSync, not execFileSync: the latter returns ONLY stdout on a
        // successful run, which silently drops every console.warn — including
        // the outbound-only warning this suite has to assert.
        const env = { ...process.env };
        for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_IDS']) delete env[key];
        Object.assign(env, extraEnv, {
            CLI_JAW_HOME: home,
            CLI_JAW_SKIP_CLI_TOOLS: '1',
            CLI_JAW_SKIP_SKILL_DEPS: '1',
            CLI_JAW_SKIP_MCP_SERVERS: '1',
            CLI_JAW_SKIP_CLAUDE: '1',
        });
        const result = spawnSync(
            process.execPath,
            ['--import', 'tsx', cliEntry, 'init', '--non-interactive', '--working-dir', '/tmp', '--cli', 'claude', ...args],
            {
                // What this suite asserts is the settings file init writes.
                // Installing tools is a different concern, and on a clean
                // runner it is a slow one, so the env assembled above skips it.
                env,
                encoding: 'utf8',
                // Bounded well under the CI step limit: a run that needs longer
                // than this is stuck, and failing it here reports which case
                // hung instead of killing the whole step with no output.
                timeout: 30_000,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
        const status = result.status ?? 1;
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        const settingsPath = join(home, 'settings.json');
        const settings = existsSync(settingsPath)
            ? JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
            : null;
        return { status, output, settings };
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

test('non-interactive slack setup writes a usable settings file', () => {
    const { status, settings } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xoxb-behaviour',
        '--slack-app-token', 'xapp-behaviour',
        '--slack-channel-ids', 'C0123456789,C9876543210',
    ]);
    assert.equal(status, 0, 'a valid setup should exit cleanly');
    assert.ok(settings, 'no settings file was written');
    assert.equal(settings['channel'], 'slack', 'active channel was not set');
    const slack = settings['slack'] as Record<string, unknown>;
    assert.equal(slack['enabled'], true);
    assert.equal(slack['botToken'], 'xoxb-behaviour');
    assert.equal(slack['appToken'], 'xapp-behaviour');
    assert.deepEqual(slack['channelIds'], ['C0123456789', 'C9876543210']);
    // Slack's defaults differ from Discord's; a wrong default here would make
    // the bot answer every message in every channel it is invited to.
    assert.equal(slack['mentionOnly'], true);
    assert.equal(slack['replyInThread'], true);
});

test('a bot token alone is accepted and reported as outbound-only', () => {
    const { status, settings, output } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xoxb-outbound',
    ]);
    assert.equal(status, 0, 'outbound-only is a legitimate configuration');
    assert.ok(settings, 'outbound-only setup should still write settings');
    const slack = settings['slack'] as Record<string, unknown>;
    assert.equal(slack['enabled'], true);
    assert.equal(slack['appToken'], '');
    assert.match(output, /outbound only/i, 'the operator was not warned');
});

test('--channel slack without a bot token fails and writes nothing', () => {
    const { status, settings, output } = runInit(['--channel', 'slack']);
    assert.notEqual(status, 0, 'a channel with no credential should not succeed');
    assert.equal(settings, null, 'a failed init must not leave a settings file');
    assert.match(output, /requires --slack-bot-token/);
});

test('swapped tokens are rejected before anything is written', () => {
    // The runbook tells operators cli-jaw validates the prefixes; without this
    // check a swap produces a green-looking file that only fails at startup.
    const { status, settings, output } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xapp-wrong-way-round',
        '--slack-app-token', 'xoxb-wrong-way-round',
    ]);
    assert.notEqual(status, 0);
    assert.equal(settings, null);
    assert.match(output, /should start with "xoxb-"/);
});

test('an invalid --channel value is rejected with all three names listed', () => {
    const { status, output } = runInit(['--channel', 'signal']);
    assert.notEqual(status, 0);
    assert.match(output, /telegram/);
    assert.match(output, /discord/);
    assert.match(output, /slack/);
});

test('slack setup does not disturb the other channels', () => {
    const { status, settings } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xoxb-isolated',
        '--telegram-token', '123:abc',
    ]);
    assert.equal(status, 0);
    assert.ok(settings);
    const telegram = settings['telegram'] as Record<string, unknown>;
    assert.equal(telegram['token'], '123:abc', 'telegram settings were clobbered');
    assert.equal((settings['slack'] as Record<string, unknown>)['enabled'], true);
});

test('environment-managed Slack init stores no connection credentials', () => {
    const { status, settings } = runInit([
        '--channel', 'slack',
    ], {
        SLACK_BOT_TOKEN: 'xoxb-environment-token',
        SLACK_APP_TOKEN: 'xapp-environment-token',
    });
    assert.equal(status, 0);
    assert.ok(settings);
    assert.equal(settings['channel'], 'slack');
    const slack = settings['slack'] as Record<string, unknown>;
    for (const key of ['enabled', 'botToken', 'appToken', 'teamId', 'channelIds', 'attachPort']) {
        assert.equal(key in slack, false, `${key} should not be persisted`);
    }
    assert.equal(JSON.stringify(settings).includes('xoxb-environment-token'), false);
});

test('environment-managed Slack init rejects mixed credential flags', () => {
    const { status, settings, output } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xoxb-file-token',
    ], { SLACK_BOT_TOKEN: 'xoxb-environment-token' });
    assert.notEqual(status, 0);
    assert.equal(settings, null);
    assert.match(output, /managed by environment variables/i);
});

test('the interactive channel prompts are gated identically for all three channels', () => {
    // THE regression this suite exists for: the interactive Slack block was
    // once gated on `channelFlag === 'slack'` while Telegram and Discord used
    // `!channelFlag || …`, so a plain `cli-jaw init` never offered Slack.
    //
    // This cannot be driven as a subprocess — init's readline interface reads
    // from a TTY and a piped stdin closes before the channel prompts are
    // reached. So the invariant is asserted structurally, but as a COMPARISON
    // between the three blocks rather than a Slack-only string match: the
    // failure mode was precisely that Slack's gate differed from its peers.
    const source = readFileSync(join(repoRoot, 'bin', 'commands', 'init.ts'), 'utf8');
    const gates = ['telegram', 'discord', 'slack'].map((channel) => {
        const pattern = new RegExp(`\\} else if \\(([^)]*'${channel}'[^)]*)\\) \\{`);
        const found = source.match(pattern);
        assert.ok(found, `no interactive gate found for ${channel}`);
        return { channel, gate: found[1]! };
    });
    const telegramGate = gates[0]!.gate;
    for (const { channel, gate } of gates) {
        assert.ok(
            gate.includes('!channelFlag'),
            `${channel}'s interactive prompt is skipped by a bare \`cli-jaw init\`: ${gate}`,
        );
        assert.equal(
            gate.replace(/'[a-z]+'/g, "'CH'"),
            telegramGate.replace(/'[a-z]+'/g, "'CH'"),
            `${channel}'s gate differs in shape from telegram's`,
        );
    }
});
