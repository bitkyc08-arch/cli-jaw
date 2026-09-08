import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { slackChannelScope } from '../../src/slack/scope-status.js';
import { slackTokenClaimPath } from '../../src/slack/token-claim.js';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

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
    assert.match(init, /if \(channelFlag && !isMessengerChannel\(channelFlag\)\)/, 'invalid --channel is rejected');
    assert.match(init, /Must be telegram, discord, or slack/, 'the error text lists valid channels');
});

test('init requires a bot token for --channel slack but only warns without the app token', () => {
    const init = read('bin/commands/init.ts');
    assert.match(init, /--channels slack requires --slack-bot-token/);
    // Outbound-only is a legitimate partial configuration.
    assert.match(init, /if \(slEnabled && !slAppToken\)/);
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
    assert.match(init, /if \(slEnabled\) messagingEnabledChannels\.push\('slack'\)/);
    assert.match(init, /if \(dcEnabled\) messagingEnabledChannels\.push\('discord'\)/);
    assert.match(init, /if \(tgEnabled\) messagingEnabledChannels\.push\('telegram'\)/);
    assert.match(init, /if \(messagingEnabledChannels\.length > 0 && !messagingEnabledChannels\.includes\(homeChannel\)\)/);
    assert.match(init, /homeChannel = messagingEnabledChannels\[0\]/);
});

test('init help lists the slack flags', () => {
    const init = read('bin/commands/init.ts');
    assert.match(init, /--slack-bot-token/);
    assert.match(init, /--slack-app-token/);
    assert.match(init, /--channels <list>/);
    assert.match(init, /--home-channel <ch>/);
    assert.match(init, /Deprecated alias for --channels/);
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
    for (const status of ['missing_bot_token', 'missing_app_token', 'token_shared_other_home']) {
        assert.match(doctor, new RegExp(status), `status ladder is missing ${status}`);
    }
    // Shape parity with Discord so JSON consumers can treat channels uniformly.
    const block = doctor.slice(doctor.indexOf('function buildSlackStatus'));
    for (const field of ['enabled', 'channelConsistent', 'runtimeReady', 'degradedReasons']) {
        assert.match(block, new RegExp(field), `buildSlackStatus omits ${field}`);
    }
    assert.match(block, /tokenClaimOwner: \{ home: tokenClaim\.claim\.home, port: tokenClaim\.claim\.port \}/);
    assert.doesNotMatch(block, /tokenClaimOwner:[^\n]*(appToken|sha256|claimId)/);
});

// An empty allowlist means "every conversation" — the shipped default. doctor
// used to call that `missing_channel_ids` and degrade on it, which is why it
// passed during the incident it should have caught: the list had exactly one
// entry, so it read as configured while every other conversation was dropped
// (#406). Asserting the judgment rather than the source text, per AGENTS.md.
test('slackChannelScope reports width instead of treating "all" as missing', () => {
    assert.deepEqual(slackChannelScope([]), { ids: [], scope: 'all_conversations' });
    assert.deepEqual(slackChannelScope(undefined), { ids: [], scope: 'all_conversations' });
    assert.deepEqual(
        slackChannelScope(['C0BJW306TE3']),
        { ids: ['C0BJW306TE3'], scope: 'allowlist_1' },
    );
    assert.equal(slackChannelScope(['A', 'B', 'C']).scope, 'allowlist_3');
});

test('doctor no longer degrades on an empty slack allowlist', () => {
    const doctor = read('bin/commands/doctor.ts');
    // Scoped to buildSlackStatus on purpose: Discord keeps its own
    // missing_channel_ids ladder, and whether that judgment is right is a
    // separate question from #406.
    const block = doctor.slice(doctor.indexOf('function buildSlackStatus'));
    assert.doesNotMatch(
        block,
        /missing_channel_ids/,
        'an empty allowlist is "every conversation", not a missing setting',
    );
    assert.match(block, /channelScope/, 'buildSlackStatus must expose the allowlist width');
    // The old field stays one major version rather than vanishing from a public
    // --json payload, but it now derives from the same gate reading (#406).
    assert.match(
        block,
        /channelIdsConfigured: channelIds\.length > 0/,
        'channelIdsConfigured must survive as a derived alias, not be dropped silently',
    );
    // A present-but-unreadable list denies every channel. Carrying that to
    // status "ok" on tokens alone is the same silence #406 is about.
    assert.match(
        block,
        /channelScope === 'malformed'/,
        'the status ladder must not pass an allowlist the gate cannot read',
    );
});

// Everything above reads the source. That proves the code says the right thing,
// not that `jaw doctor --json` prints it — and the whole point of #406 is that a
// reporting surface disagreed with the gate. So run the real command.
//
// Through the repo's own tsx and an isolated --home: a global `jaw` would be
// ENOENT on clean CI and would check the INSTALLED build on a dev host, which is
// a false green either way (the multi-instance integration test's pattern).
test('doctor --json reports the allowlist width the gate enforces', () => {
    const repoTsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
    const cliEntry = join(repoRoot, 'bin', 'cli-jaw.ts');
    // No conditional skip. A nested `test.skip()` marks an inner test skipped and
    // lets the OUTER one pass, so the check that matters would report green in
    // exactly the environment where it never ran. tsx is a devDependency; if it
    // is missing, the install is broken and this should say so.
    assert.ok(existsSync(repoTsx), `repo-local tsx is required to run the CLI: ${repoTsx}`);

    const runDoctor = (channelIds: unknown) => {
        const home = mkdtempSync(join(tmpdir(), 'jaw-slack-scope-'));
        try {
            const settingsPath = join(home, 'settings.json');
            writeFileSync(settingsPath, JSON.stringify({
                slack: {
                    enabled: true,
                    botToken: 'xoxb-doctor-json-fixture',
                    appToken: 'xapp-doctor-json-fixture',
                    teamId: 'T_FIXTURE',
                    channelIds,
                },
            }));
            chmodSync(settingsPath, 0o600);
            // Not execFileSync: doctor exits non-zero whenever ANY check is
            // warn/error, and a throwaway home has several (no db, no skills
            // dir). That says nothing about the Slack block, which is printed
            // either way — so read stdout on its own terms.
            const run = spawnSync(repoTsx, [cliEntry, '--home', home, 'doctor', '--json'], {
                cwd: repoRoot, encoding: 'utf8', timeout: 60000,
                // The Slack connection fields are env-owned when these are set,
                // which would override the fixture and silently test nothing.
                env: {
                    ...process.env, NO_COLOR: '1',
                    SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '', SLACK_CHANNEL_IDS: '', SLACK_TEAM_ID: '',
                },
            });
            assert.ok(run.stdout, `doctor printed nothing: ${run.stderr || run.error}`);
            return JSON.parse(run.stdout).slack;
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    };

    // Empty is 'every conversation', the shipped default — not a defect.
    const all = runDoctor([]);
    assert.equal(all.channelScope, 'all_conversations');
    assert.notEqual(all.status, 'missing_channel_ids');
    assert.equal(all.channelIdsConfigured, false);

    // A narrowed list reports its width, which is what the incident needed.
    const narrowed = runDoctor(['C0BJW306TE3']);
    assert.equal(narrowed.channelScope, 'allowlist_1');
    assert.deepEqual(narrowed.channelIds, ['C0BJW306TE3']);
    assert.equal(narrowed.channelIdsConfigured, true);

    // A value the gate cannot read denies every channel, so doctor must not
    // answer ok on tokens alone.
    const malformed = runDoctor('C0BJW306TE3');
    assert.equal(malformed.channelScope, 'malformed');
    assert.equal(malformed.status, 'malformed_channel_ids');
    assert.equal(malformed.runtimeReady, false);
    // The denial sentinel is not a conversation and must not be printed as one.
    assert.deepEqual(malformed.channelIds, []);
});

test('doctor text and JSON identify a foreign owner without exposing token material', () => {
    const repoTsx = join(repoRoot, 'node_modules', '.bin', 'tsx');
    const cliEntry = join(repoRoot, 'bin', 'cli-jaw.ts');
    const home = mkdtempSync(join(tmpdir(), 'jaw-doctor-owner-'));
    const foreignHome = mkdtempSync(join(tmpdir(), 'jaw-doctor-foreign-'));
    const sharedHome = mkdtempSync(join(tmpdir(), 'jaw-doctor-shared-'));
    const token = 'xapp-doctor-owner-secret';
    try {
        writeFileSync(join(home, 'settings.json'), JSON.stringify({
            port: '3457',
            slack: { enabled: true, botToken: 'xoxb-fixture', appToken: token, teamId: 'T1', channelIds: [] },
        }));
        const claimRoot = join(sharedHome, '.cli-jaw-shared', 'slack-claims');
        const claimPath = slackTokenClaimPath(token, claimRoot);
        mkdirSync(dirname(claimPath), { recursive: true });
        writeFileSync(claimPath, JSON.stringify({
            version: 1, claimId: 'd'.repeat(32), home: foreignHome, port: '4567',
            pid: process.pid, claimedAt: new Date().toISOString(), connected: true,
        }));
        const run = spawnSync(repoTsx, [cliEntry, '--home', home, 'doctor', '--json'], {
            cwd: repoRoot, encoding: 'utf8', timeout: 60_000,
            env: { ...process.env, HOME: sharedHome, NO_COLOR: '1', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' },
        });
        assert.ok(run.stdout, run.stderr);
        const slack = JSON.parse(run.stdout).slack;
        assert.equal(slack.status, 'token_shared_other_home');
        assert.deepEqual(slack.tokenClaimOwner, { home: foreignHome, port: '4567' });
        const rendered = `${run.stdout}\n${run.stderr}`;
        assert.doesNotMatch(rendered, new RegExp(token));
        assert.doesNotMatch(rendered, /[0-9a-f]{64}\.json/);
    } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(foreignHome, { recursive: true, force: true });
        rmSync(sharedHome, { recursive: true, force: true });
    }
});

// ─── source-of-truth docs ───────────────────────────

test('SoT docs document the slack channel', () => {
    assert.match(read('structure/INDEX.md'), /Slack/, 'INDEX.md does not mention Slack');
    assert.match(read('structure/server_api.md'), /\/api\/slack\/send/, 'the route is undocumented');
    assert.match(read('structure/commands.md'), /Slack 41/, 'command visibility counts omit Slack');
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



// An agent narrowed slack.channelIds while setting up a channel heartbeat and
// cut off every other conversation, including the one it would have needed to
// be told. Nothing in the prompt said that list was its own inbound surface (#406).
test('the agent prompt names the inbound allowlist as something not to narrow', async () => {
    const { getSystemPrompt } = await import('../../src/prompt/builder.js');

    // The assembled runtime prompt, not the helper: an agent only ever sees
    // what getSystemPrompt returns, and cursor spawns with forDisk:false.
    const runtime = getSystemPrompt({ forDisk: false });
    assert.match(runtime, /slack\.channelIds/, 'the setting must be named in the runtime prompt');
    assert.match(runtime, /HEAR|listens/i, 'the prompt must say this list is how the agent is reached');
    assert.match(runtime, /target/, 'the prompt must point channel-scoped work at target instead');

    // The disk prompt (AGENTS.md) is a different branch and must carry it too.
    const disk = getSystemPrompt({ forDisk: true });
    assert.match(disk, /slack\.channelIds/, 'AGENTS.md must carry the same warning');
});

// The gate stays silent about the one drop reason that means a human
// configured us out of a conversation. Without this the allowlist mistake reads
// as a dead bot: preflight drops the event, nothing reaches dispatch, and
// dispatch is the only consumer that logs (#406).

// Reading it any other way is how the two paths drifted: a malformed value
// blocked messages while slash commands still ran everywhere, and doctor
// reported a reach the bot did not have (#406).
test('every allowlist reader agrees with the gate', async () => {
    const { readSlackAllowlist, MALFORMED_SLACK_ALLOWLIST, SLACK_ALLOWLIST_MAX } =
        await import('../../src/slack/events.js');
    const { slackChannelScope } = await import('../../src/slack/scope-status.js');

    // Padding and duplicates: the gate matches one channel, so doctor must say one.
    assert.deepEqual(readSlackAllowlist([' C1 ', 'C1', '']), ['C1']);
    assert.equal(slackChannelScope([' C1 ', 'C1', '']).scope, 'allowlist_1');

    // Malformed: the gate denies every channel, so doctor must not call it "all".
    for (const bad of ['C1', ['C1', 7], { 0: 'C1' }]) {
        assert.deepEqual(readSlackAllowlist(bad), [MALFORMED_SLACK_ALLOWLIST]);
        assert.equal(slackChannelScope(bad).scope, 'malformed');
    }

    // Empty means every conversation on both sides.
    assert.deepEqual(readSlackAllowlist([]), []);
    assert.equal(slackChannelScope([]).scope, 'all_conversations');
    assert.equal(slackChannelScope(undefined).scope, 'all_conversations');

    // The ceiling binds in the reader, not just the route, because settings also
    // arrive from the file watcher and from a hand-edited settings.json.
    const atLimit = Array.from({ length: SLACK_ALLOWLIST_MAX }, (_, i) => `C${i}`);
    assert.equal(readSlackAllowlist(atLimit).length, SLACK_ALLOWLIST_MAX);
    assert.deepEqual(readSlackAllowlist([...atLimit, 'C_OVER']), [MALFORMED_SLACK_ALLOWLIST]);

    // The sentinel is a denial marker, not a conversation. It must not reach a
    // reporting surface as if it were one.
    for (const bad of [null, [''], 'C1']) {
        assert.deepEqual(slackChannelScope(bad).ids, [], 'the sentinel must not leak into a report');
    }
});

// The slash-command path used to parse the allowlist itself, so a malformed
// value blocked ordinary messages while commands still ran in every channel.
test('the slash command path reads the allowlist through the gate helper', () => {
    const commands = read('src/slack/commands.ts');
    assert.match(commands, /readSlackAllowlist\(settings\[.slack.\]\?\.channelIds\)/);
    assert.doesNotMatch(
        commands,
        /Array\.isArray\(configured\)/,
        'the slash path must not parse the allowlist on its own',
    );
});
