import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

type RunResult = { status: number; stdout: string; settings: Record<string, unknown> | null };

function runInit(args: string[]): RunResult {
    const home = mkdtempSync(join(homedir(), '.cljaw-test-'));
    try {
        let status = 0;
        let stdout = '';
        try {
            stdout = execFileSync(
                process.execPath,
                ['--import', 'tsx', cliEntry, 'init', '--non-interactive', '--working-dir', '/tmp', '--cli', 'claude', ...args],
                { env: { ...process.env, CLI_JAW_HOME: home }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
            );
        } catch (error) {
            const e = error as { status?: number; stdout?: string; stderr?: string };
            status = e.status ?? 1;
            stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
        }
        const settingsPath = join(home, 'settings.json');
        const settings = existsSync(settingsPath)
            ? JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
            : null;
        return { status, stdout, settings };
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

test('non-interactive slack setup writes a usable settings file', () => {
    const { settings } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xoxb-behaviour',
        '--slack-app-token', 'xapp-behaviour',
        '--slack-channel-ids', 'C0123456789,C9876543210',
    ]);
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
    const { settings, stdout } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xoxb-outbound',
    ]);
    assert.ok(settings, 'outbound-only setup should still write settings');
    const slack = settings['slack'] as Record<string, unknown>;
    assert.equal(slack['enabled'], true);
    assert.equal(slack['appToken'], '');
    assert.match(stdout, /outbound only/i, 'the operator was not warned');
});

test('--channel slack without a bot token fails and writes nothing', () => {
    const { status, settings, stdout } = runInit(['--channel', 'slack']);
    assert.notEqual(status, 0, 'a channel with no credential should not succeed');
    assert.equal(settings, null, 'a failed init must not leave a settings file');
    assert.match(stdout, /requires --slack-bot-token/);
});

test('swapped tokens are rejected before anything is written', () => {
    // The runbook tells operators cli-jaw validates the prefixes; without this
    // check a swap produces a green-looking file that only fails at startup.
    const { status, settings, stdout } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xapp-wrong-way-round',
        '--slack-app-token', 'xoxb-wrong-way-round',
    ]);
    assert.notEqual(status, 0);
    assert.equal(settings, null);
    assert.match(stdout, /should start with "xoxb-"/);
});

test('an invalid --channel value is rejected with all three names listed', () => {
    const { status, stdout } = runInit(['--channel', 'signal']);
    assert.notEqual(status, 0);
    assert.match(stdout, /telegram/);
    assert.match(stdout, /discord/);
    assert.match(stdout, /slack/);
});

test('slack setup does not disturb the other channels', () => {
    const { settings } = runInit([
        '--channel', 'slack',
        '--slack-bot-token', 'xoxb-isolated',
        '--telegram-token', '123:abc',
    ]);
    assert.ok(settings);
    const telegram = settings['telegram'] as Record<string, unknown>;
    assert.equal(telegram['token'], '123:abc', 'telegram settings were clobbered');
    assert.equal((settings['slack'] as Record<string, unknown>)['enabled'], true);
});
