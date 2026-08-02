import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

// `devlog` is a private submodule. CI checks it out only when SUBMODULE_PAT is
// configured, and skips it otherwise -- so a test that reads a devlog file
// fails with ENOENT on every fork and on any run without the secret. That is a
// missing input, not a defect in the thing under test.
const runbookPath = 'devlog/_plan/260802_slack_channel/051_operator_runbook.md';
const hasRunbook = existsSync(join(repoRoot, runbookPath));

// ─── cli-jaw init ───────────────────────────────────

test('init declares the four slack flags', () => {
    // parseArgs runs with strict:true, so an undeclared flag is a hard error —
    // non-interactive Slack setup is impossible without these.
    const init = read('bin/commands/init.ts');
    for (const flag of ['slack-bot-token', 'slack-app-token', 'slack-team-id', 'slack-channel-ids']) {
        assert.match(init, new RegExp(`'${flag}': \\{ type: 'string' \\}`), `--${flag} is not declared`);
    }
});

test('init accepts --channel slack and says so in its error text', () => {
    const init = read('bin/commands/init.ts');
    assert.match(init, /channelFlag !== 'slack'/, '--channel slack would be rejected');
    assert.match(init, /Must be "telegram", "discord", or "slack"/, 'the error text still lists two channels');
});

test('init requires a bot token for --channel slack but only warns without the app token', () => {
    const init = read('bin/commands/init.ts');
    assert.match(init, /channelFlag === 'slack' && !slEnabled/);
    assert.match(init, /requires --slack-bot-token/);
    // Outbound-only is a legitimate partial configuration.
    assert.match(init, /slEnabled && !slAppToken/);
    assert.match(init, /outbound only, no inbound events/);
});

test('init writes the slack settings block with Slack-correct defaults', () => {
    const init = read('bin/commands/init.ts');
    const block = init.slice(init.indexOf('merged.slack'));
    assert.match(block, /botToken: slBotToken/);
    assert.match(block, /appToken: slAppToken/);
    assert.match(block, /mentionOnly: true/, 'Slack mentionOnly must default true');
    assert.match(block, /replyInThread: true/, 'Slack replyInThread must default true');
});

test('init infers the active channel only when slack alone is configured', () => {
    const init = read('bin/commands/init.ts');
    assert.match(init, /slEnabled && !tgEnabled && !dcEnabled\) activeChannel = 'slack'/);
    // The pre-existing arms must also exclude slack, or two configured
    // channels would silently pick one.
    assert.match(init, /dcEnabled && !tgEnabled && !slEnabled/);
    assert.match(init, /tgEnabled && !dcEnabled && !slEnabled/);
});

test('init help lists the slack flags', () => {
    const init = read('bin/commands/init.ts');
    assert.match(init, /--slack-bot-token/);
    assert.match(init, /--slack-app-token/);
    assert.match(init, /Active channel \(telegram, discord, or slack\)/);
});

// ─── cli-jaw doctor ─────────────────────────────────

test('doctor types slack settings separately from MessagingSettings', () => {
    // MessagingSettings has a single `token`; Slack needs two distinctly-scoped
    // tokens, and extending it would invite settings.slack.token typos.
    const doctor = read('bin/commands/doctor.ts');
    assert.match(doctor, /interface SlackSettings \{/);
    assert.match(doctor, /botToken\?: string;/);
    assert.match(doctor, /appToken\?: string;/);
    assert.match(doctor, /slack\?: SlackSettings;/, 'DoctorSettings has no slack member');
});

test('doctor runs a Slack check in normal mode, not only --json', () => {
    // Plain `cli-jaw doctor` is what an operator actually runs.
    const doctor = read('bin/commands/doctor.ts');
    assert.match(doctor, /check\('Slack', \(\) => \{/);
    assert.match(doctor, /bot token should start with xoxb-/);
    assert.match(doctor, /app token should start with xapp-/);
    assert.match(doctor, /WARN: app-level token missing/);
});

test('doctor channel consistency covers slack', () => {
    const doctor = read('bin/commands/doctor.ts');
    assert.match(doctor, /ch === 'slack' && !settings\?\.slack\?\.enabled/);
});

test('doctor --json emits a slack status object with the full ladder', () => {
    const doctor = read('bin/commands/doctor.ts');
    assert.match(doctor, /function buildSlackStatus\(\)/);
    assert.match(doctor, /slack: buildSlackStatus\(\),/, 'the JSON output has no slack member');
    for (const status of ['missing_bot_token', 'missing_app_token', 'missing_channel_ids']) {
        assert.match(doctor, new RegExp(status), `status ladder is missing ${status}`);
    }
    // Shape parity with Discord so JSON consumers can treat channels uniformly.
    const block = doctor.slice(doctor.indexOf('function buildSlackStatus'));
    for (const field of ['enabled', 'channelConsistent', 'runtimeReady', 'degradedReasons']) {
        assert.match(block, new RegExp(field), `buildSlackStatus omits ${field}`);
    }
});

// ─── source-of-truth docs ───────────────────────────

test('SoT docs document the slack channel', () => {
    assert.match(read('structure/INDEX.md'), /Slack/, 'INDEX.md does not mention Slack');
    assert.match(read('structure/server_api.md'), /\/api\/slack\/send/, 'the route is undocumented');
    assert.match(read('structure/commands.md'), /Slack 37/, 'command visibility counts omit Slack');
    assert.match(read('structure/telegram.md'), /Telegram\/Discord\/Slack/, 'the channel hub doc omits Slack');
    // The file tree renders paths as indented segments (`slack/`), not full
    // paths, so match the section header the way the document writes it.
    assert.match(read('structure/str_func.md'), /slack\/\s+← Slack 인터페이스/, 'the file tree omits the slack section');
    assert.match(read('structure/str_func.md'), /socket\.ts.*Socket Mode client/, 'socket.ts is undocumented');
});

test('root docs list slack as a supported channel', () => {
    assert.match(read('CLAUDE.md'), /Telegram\/Discord\/Slack channels/);
    assert.match(read('README.md'), /Telegram, Discord, or Slack/);
});

test('the operator runbook exists and covers the setup essentials', {
    skip: !hasRunbook && 'devlog submodule not checked out (needs SUBMODULE_PAT)',
}, () => {
    const runbook = read(runbookPath);
    assert.match(runbook, /_metadata:/, 'no app manifest');
    assert.match(runbook, /connections:write/, 'the app-level token scope is undocumented');
    assert.match(runbook, /xoxb-/);
    assert.match(runbook, /xapp-/);
    assert.match(runbook, /invite @cli-jaw/, 'the invite step is missing');
    assert.match(runbook, /message\.im/, 'the DM subscription gotcha is undocumented');
    assert.match(runbook, /Troubleshooting/i);
});
