/**
 * cli-jaw init — Phase 9.3
 * Interactive setup wizard or --non-interactive flag mode.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import fs from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    JAW_HOME,
    SETTINGS_PATH,
    freshInstallSchemaFields,
    settingsForHomeWithoutSettingsFile,
    configuredSlackEnvironmentVariables,
    SLACK_CONNECTION_SETTING_KEYS,
} from '../../src/core/config.js';
import { CLI_KEYS } from '../../src/cli/registry.js';
import { SWITCHABLE_NATIVE_CLIS, resolveRuntimeTransport } from '../../src/agent/runtime/selection.js';
import type { RuntimeTransport } from '../../src/shared/runtime-contract.js';
import type { MessengerChannel } from '../../src/messaging/types.js';

const CLI_CHOICES = CLI_KEYS.join(', ');
const MESSENGER_CHANNELS = ['telegram', 'discord', 'slack'] as const;
const isMessengerChannel = (value: unknown): value is MessengerChannel =>
    MESSENGER_CHANNELS.includes(value as MessengerChannel);


const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        help: { type: 'boolean', default: false },
        'non-interactive': { type: 'boolean', default: false },
        safe: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
       'working-dir': { type: 'string' },
       cli: { type: 'string' },
       channel: { type: 'string' },
        channels: { type: 'string' },
        'home-channel': { type: 'string' },
       'telegram-token': { type: 'string' },
        'allowed-chat-ids': { type: 'string' },
        'discord-token': { type: 'string' },
        'discord-guild-id': { type: 'string' },
        'discord-channel-ids': { type: 'string' },
        'slack-bot-token': { type: 'string' },
        'slack-app-token': { type: 'string' },
        'slack-team-id': { type: 'string' },
        'slack-channel-ids': { type: 'string' },
        'skills-dir': { type: 'string' },
    },
    strict: true,
});

if (values.help) {
    console.log(`Usage: jaw init [options]

Options:
  --help                Show this help
  --non-interactive     Skip prompts, use defaults
  --safe                Ask before optional installs
  --dry-run             Show what would be done without changes
  --force               Overwrite existing settings
  --working-dir <path>  Set working directory
  --cli <name>          Default CLI (${CLI_CHOICES})
  --channel <ch>        Deprecated alias for --channels <ch> --home-channel <ch>
  --channels <list>     Comma-separated enabled inbound gateways (telegram,discord,slack)
  --home-channel <ch>     Default channel for proactive outbound (telegram, discord, or slack)
  --telegram-token <t>  Telegram bot token
  --allowed-chat-ids <ids>  Comma-separated Telegram chat IDs
  --discord-token <t>   Discord bot token
  --discord-guild-id <id>   Discord guild (server) ID
  --discord-channel-ids <ids>  Comma-separated Discord channel IDs
  --slack-bot-token <t>     Slack bot token (xoxb-...)
  --slack-app-token <t>     Slack app-level token (xapp-..., required for inbound)
  --slack-team-id <id>      Slack team ID (optional)
  --slack-channel-ids <ids> Comma-separated Slack conversation IDs
  --skills-dir <path>   Skills directory`);
    process.exit(0);
}

// Ensure home dir
fs.mkdirSync(JAW_HOME, { recursive: true });

interface InitSettings {
    workingDir?: string;
    perCli?: Record<string, { model?: string; effort?: string; transport?: RuntimeTransport; [key: string]: unknown }>;
   cli?: string;
   telegram?: { enabled?: boolean; token?: string; allowedChatIds?: unknown[] };
   discord?: {
        enabled?: boolean;
        token?: string;
        guildId?: string;
        channelIds?: unknown[];
        forwardAll?: boolean;
        allowBots?: boolean;
    };
    slack?: {
        enabled?: boolean;
        botToken?: string;
        appToken?: string;
        teamId?: string;
        channelIds?: unknown[];
        forwardAll?: boolean;
        allowBots?: boolean;
        mentionOnly?: boolean;
        replyInThread?: boolean;
    };
    skillsDir?: string;
    messaging?: {
        enabledChannels?: MessengerChannel[];
        homeChannel?: MessengerChannel;
        [k: string]: unknown;
    };
    channel?: string;
    [k: string]: unknown;
}

// Load existing settings — fail if exists and no --force
let settings: InitSettings = {};
const settingsExist = fs.existsSync(SETTINGS_PATH);
if (settingsExist && !values.force) {
    console.error('  ❌ settings.json already exists. Use --force to overwrite.');
    process.exit(1);
}
if (settingsExist) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { } // best-effort: corrupt settings falls back to defaults
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string, def: string): Promise<string> => new Promise(r => {
    if (values['non-interactive']) { r(def); return; }
    rl.question(`  ${q} [${def}]: `, (ans) => r(ans.trim() || def));
});

console.log('\n  🦈 cli-jaw 초기 설정\n');

// Collect
const workingDir = String(values['working-dir'] ||
    await ask('Working directory', settings.workingDir || JAW_HOME));
const cli = String(values.cli ||
    await ask(`CLI (${CLI_CHOICES})`, settings.cli || 'claude'));

// Channel selection
const channelFlag = values.channel as string | undefined;
const channelsFlag = values.channels as string | undefined;
const homeChannelFlag = values['home-channel'] as string | undefined;

function parseChannelsInput(raw: string | undefined): MessengerChannel[] | undefined {
    if (!raw) return undefined;
    return raw.split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .filter((ch): ch is MessengerChannel => {
            if (isMessengerChannel(ch)) return true;
            console.error(`  ❌ Invalid channel "${ch}" in --channels. Must be telegram, discord, or slack.`);
            process.exit(1);
        });
}

if (channelFlag && channelsFlag) {
    console.error('  ❌ --channel cannot be used with --channels. Use --channels and --home-channel instead.');
    process.exit(1);
}
if (channelFlag && !isMessengerChannel(channelFlag)) {
    console.error(`  ❌ Invalid --channel "${channelFlag}". Must be telegram, discord, or slack.`);
    process.exit(1);
}
if (homeChannelFlag && !isMessengerChannel(homeChannelFlag)) {
    console.error(`  ❌ Invalid --home-channel "${homeChannelFlag}". Must be telegram, discord, or slack.`);
    process.exit(1);
}

const legacyChannelFlag: MessengerChannel | undefined = isMessengerChannel(channelFlag)
    ? channelFlag
    : undefined;
const flagEnabledChannels = parseChannelsInput(channelsFlag) ||
    (legacyChannelFlag ? [legacyChannelFlag] : undefined);
const requestedChannels: Set<MessengerChannel> = flagEnabledChannels
    ? new Set(flagEnabledChannels)
    : values['non-interactive']
        ? new Set<MessengerChannel>()
        : new Set<MessengerChannel>(MESSENGER_CHANNELS);

const slackEnvironmentVariables = configuredSlackEnvironmentVariables();
const slackEnvironmentManaged = slackEnvironmentVariables.length > 0;
const slackCredentialFlags = [
    'slack-bot-token',
    'slack-app-token',
    'slack-team-id',
    'slack-channel-ids',
] as const;
if (slackEnvironmentManaged && slackCredentialFlags.some((key) => values[key] !== undefined)) {
    console.error(`  ❌ Slack connection settings are managed by environment variables (${slackEnvironmentVariables.join(', ')}). Remove them before passing Slack credential flags.`);
    process.exit(1);
}

// Telegram
let tgEnabled = false, tgToken = '', tgChatIds: number[] = [];
if (values['non-interactive']) {
    if (values['telegram-token']) {
        tgEnabled = true;
        tgToken = values['telegram-token'] as string;
        tgChatIds = ((values['allowed-chat-ids'] || '') as string).split(',').map((s: string) => +s.trim()).filter(Boolean);
    }
} else if (requestedChannels.has('telegram')) {
    const tgAnswer = await ask('Telegram 연결? (y/n)', settings.telegram?.enabled ? 'y' : 'n');
    tgEnabled = tgAnswer.toLowerCase() === 'y';
    if (tgEnabled) {
        tgToken = await ask('Bot token', settings.telegram?.token || '');
        const idsStr = await ask('Chat IDs (comma)',
            (settings.telegram?.allowedChatIds || []).join(',') || '');
        tgChatIds = idsStr.split(',').map((s: string) => +s.trim()).filter(Boolean);
    }
}

// Discord
let dcEnabled = false, dcToken = '', dcGuildId = '', dcChannelIds: string[] = [];
if (values['non-interactive']) {
    if (values['discord-token']) {
        dcToken = values['discord-token'] as string;
        dcGuildId = String(values['discord-guild-id'] || '');
        dcChannelIds = ((values['discord-channel-ids'] || '') as string).split(',').map(s => s.trim()).filter(Boolean);
        dcEnabled = true;
    }
} else if (requestedChannels.has('discord')) {
    const dcAnswer = await ask('Discord 연결? (y/n)', settings.discord?.enabled ? 'y' : 'n');
    dcEnabled = dcAnswer.toLowerCase() === 'y';
    if (dcEnabled) {
        dcToken = await ask('Bot token', settings.discord?.token || '');
        dcGuildId = await ask('Guild ID', settings.discord?.guildId || '');
        const idsStr = await ask('Channel IDs (comma)',
            (settings.discord?.channelIds || []).join(',') || '');
        dcChannelIds = idsStr.split(',').map(s => s.trim()).filter(Boolean);
    }
}

// Slack
let slEnabled = false, slBotToken = '', slAppToken = '', slTeamId = '', slChannelIds: string[] = [];
if (slackEnvironmentManaged) {
    if (!values['non-interactive']) {
        console.log(`  Slack connection settings are managed by environment variables (${slackEnvironmentVariables.join(', ')}); skipping credential prompts.`);
    }
} else if (values['non-interactive']) {
    if (values['slack-bot-token']) {
        slBotToken = values['slack-bot-token'] as string;
        slAppToken = String(values['slack-app-token'] || '');
        slTeamId = String(values['slack-team-id'] || '');
        slChannelIds = ((values['slack-channel-ids'] || '') as string).split(',').map(s => s.trim()).filter(Boolean);
        slEnabled = true;
    }
} else if (requestedChannels.has('slack')) {
    // Matches the Telegram and Discord blocks: a bare `cli-jaw init` offers
    // every channel. Gating this on the flag alone would hide Slack from the
    // default interactive setup entirely.
    const slAnswer = await ask('Slack 연결? (y/n)', settings.slack?.enabled ? 'y' : 'n');
    slEnabled = slAnswer.toLowerCase() === 'y';
    if (slEnabled) {
        slBotToken = await ask('Bot token (xoxb-...)', settings.slack?.botToken || '');
        slAppToken = await ask('App-level token (xapp-...)', settings.slack?.appToken || '');
        slTeamId = await ask('Team ID (optional)', settings.slack?.teamId || '');
        const idsStr = await ask('Channel IDs (comma)',
            (settings.slack?.channelIds || []).join(',') || '');
        slChannelIds = idsStr.split(',').map(s => s.trim()).filter(Boolean);
    }
}

// Validate: --channel discord requires Discord config
if (requestedChannels.has('discord') && !dcEnabled) {
    console.error('  ❌ --channels discord requires --discord-token.');
    process.exit(1);
}

// Validate: --channel slack requires at least the bot token
if (requestedChannels.has('slack') && !slEnabled && !process.env['SLACK_BOT_TOKEN']) {
    console.error('  ❌ --channels slack requires --slack-bot-token.');
    process.exit(1);
}
// Catch swapped tokens BEFORE writing. Otherwise init produces a
// green-looking settings file and the mistake only surfaces after the server
// starts and auth.test fails.
if (slEnabled && slBotToken && !slBotToken.startsWith('xoxb-')) {
    console.error(`  ❌ Slack bot token should start with "xoxb-" (got "${slBotToken.slice(0, 5)}…"). Did you swap it with the app-level token?`);
    process.exit(1);
}
if (slAppToken && !slAppToken.startsWith('xapp-')) {
    console.error(`  ❌ Slack app-level token should start with "xapp-" (got "${slAppToken.slice(0, 5)}…"). Did you swap it with the bot token?`);
    process.exit(1);
}
// Outbound-only is a legitimate partial configuration, so this warns rather
// than exiting — it is the same state channel-health reports as
// missing_app_token.
if (slEnabled && !slAppToken) {
    console.warn('  ⚠️  Slack app-level token missing — outbound only, no inbound events.');
}

// Validate Discord flags
if (dcEnabled) {
    if (!dcToken) {
        console.error('  ❌ Discord token is required.');
        process.exit(1);
    }
    if (!dcGuildId) {
        console.error('  ❌ Discord guild ID is required.');
        process.exit(1);
    }
    if (!dcChannelIds.length) {
        console.error('  ❌ At least one Discord channel ID is required.');
        process.exit(1);
    }
}

// Skills dir
const skillsDir = String(values['skills-dir'] ||
    await ask('Skills directory', settings.skillsDir || path.join(JAW_HOME, 'skills')));

rl.close();

// Determine enabled gateways and home channel (legacy single-selection kept as comment: dcEnabled && !tgEnabled).
const messagingEnabledChannels: MessengerChannel[] = [];
if (tgEnabled) messagingEnabledChannels.push('telegram');
if (dcEnabled) messagingEnabledChannels.push('discord');
if (slEnabled) messagingEnabledChannels.push('slack');

let homeChannel: MessengerChannel = 'telegram';
if (homeChannelFlag && isMessengerChannel(homeChannelFlag)) {
    homeChannel = homeChannelFlag;
} else if (channelFlag && isMessengerChannel(channelFlag)) {
    homeChannel = channelFlag;
} else {
    const existingHome = settings.messaging?.homeChannel ?? settings.channel;
    if (isMessengerChannel(existingHome as unknown)) homeChannel = existingHome as MessengerChannel;
}
// Did the caller actually NAME a channel, or is `homeChannel` still carrying its
// `'telegram'` seed? The old code could not tell, and unshifted either one into the
// enabled set. For `--channel slack` that unshift is load-bearing: an environment-managed
// Slack install has its credentials in env, so no `--slack-bot-token` is passed,
// `slEnabled` stays false, and the enabled set is empty even though Slack is exactly what
// was asked for. For a bare `init --non-interactive` the same line enabled telegram —
// a channel nobody configured — and the summary printed "Gateways: telegram" beside
// "Telegram: off" before writing that contradiction to disk (#395).
const homeChannelRequested = Boolean(
    (homeChannelFlag && isMessengerChannel(homeChannelFlag))
    || (channelFlag && isMessengerChannel(channelFlag))
    || flagEnabledChannels?.length,
);
if (messagingEnabledChannels.length > 0 && !messagingEnabledChannels.includes(homeChannel)) {
    homeChannel = messagingEnabledChannels[0] ?? 'telegram';
}
// Only a named channel may enable itself this way. An unnamed default may not.
if (homeChannelRequested && !messagingEnabledChannels.includes(homeChannel)) {
    messagingEnabledChannels.unshift(homeChannel);
}

// Merge (preserve existing values unless --force)
const merged: InitSettings = values.force ? {} : { ...settings };
// A document being created here is a new install, so it says which schema it was written
// under and carries what that schema requires. Left unstamped, the loader reads an absent
// version as v1 and treats the install as legacy — the person who just ran `init` would be
// offered a migration away from a state they never had (110 §4b-3).
//
// This applies ONLY when there was no file. Stamping an existing document would be the
// same mistake pointing the other way: a genuine legacy install would claim the current
// schema, skip its migration, and be switched on without ever being asked. `--force`
// rewrites the document but does not make the installation new, so it is excluded too.
if (!settingsExist) {
    Object.assign(merged, freshInstallSchemaFields());
    const initial = settingsForHomeWithoutSettingsFile();
    merged.perCli = { ...merged.perCli };
    for (const cli of SWITCHABLE_NATIVE_CLIS) {
        merged.perCli[cli] = {
            ...merged.perCli[cli],
            transport: resolveRuntimeTransport(initial.perCli[cli]?.transport),
        };
    }
}
merged.workingDir = workingDir;
merged.cli = cli;
merged["permissions"] = 'auto';
merged.skillsDir = skillsDir;
delete merged['channel'];
merged.messaging = {
    ...(settings.messaging || {}),
    enabledChannels: messagingEnabledChannels,
    homeChannel,
};
if (tgEnabled || values.force) {
    merged.telegram = { enabled: tgEnabled, token: tgToken, allowedChatIds: tgChatIds };
}
if (dcEnabled || values.force) {
    merged.discord = {
        enabled: dcEnabled,
        token: dcToken,
        guildId: dcGuildId,
        channelIds: dcChannelIds,
        forwardAll: true,
        allowBots: false,
    };
}
if (slackEnvironmentManaged) {
    const persistedSlack = { ...(settings.slack || {}) } as Record<string, unknown>;
    for (const key of SLACK_CONNECTION_SETTING_KEYS) delete persistedSlack[key];
    merged.slack = {
        forwardAll: true,
        allowBots: false,
        mentionOnly: true,
        replyInThread: true,
        ...persistedSlack,
    };
} else if (slEnabled || values.force) {
    merged.slack = {
        enabled: slEnabled,
        botToken: slBotToken,
        appToken: slAppToken,
        teamId: slTeamId,
        channelIds: slChannelIds,
        forwardAll: true,
        allowBots: false,
        // Slack bots usually live in shared channels, so both default ON.
        mentionOnly: true,
        replyInThread: true,
    };
}

// Save (skip in dry-run)
if (!values['dry-run']) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
    // Tokens (telegram/discord/slack) may have just been written — owner-only.
    if (process.platform !== 'win32') {
        try { fs.chmodSync(SETTINGS_PATH, 0o600); } catch { /* best-effort */ }
    }

    // Ensure skills dir + heartbeat.json
    fs.mkdirSync(skillsDir as string, { recursive: true });
    const hbPath = path.join(JAW_HOME, 'heartbeat.json');
    if (!fs.existsSync(hbPath)) {
        fs.writeFileSync(hbPath, JSON.stringify({ jobs: [] }, null, 2));
    }
} else {
    console.log('  [dry-run] would save settings to', SETTINGS_PATH);
    console.log('  [dry-run] would create', skillsDir);
}

// Step-by-step component install — dynamic import to prevent postinstall top-level side effects
const { installCliTools, installMcpServers, installSkillDeps } = await import('../postinstall.js') as
    typeof import('../postinstall.js');

type InstallOpts = Parameters<typeof installCliTools>[0];
const installOpts: InstallOpts = {
    dryRun: !!values['dry-run'],
    interactive: !!values.safe || !values['non-interactive'],
    ask: async (question: string, defaultVal: string): Promise<string> => {
        if (values['non-interactive']) return defaultVal;
        return new Promise(r => {
            const rl2 = createInterface({ input: process.stdin, output: process.stdout });
            rl2.question(`  ${question} `, (ans) => { rl2.close(); r(ans.trim() || defaultVal); });
        });
    },
};

if (values['dry-run']) console.log('\n  \ud83d\udd0d Dry run mode — no changes will be made\n');

// These switches were honoured by the npm postinstall path only, so `jaw init`
// reached for the network regardless of what the caller asked for. That is what
// made the init behavior suite unrunnable on CI: a clean runner has none of
// these tools, so each of its six subprocesses npm-installed the provider CLI
// set plus uv and playwright-core, and the step hit its limit before the first
// assertion printed.
//
// Same variables, same spelling, now honoured wherever the installers are
// driven from.
const skipEnv = (name: string) => process.env[name] === '1' || process.env[name] === 'true';

if (skipEnv('CLI_JAW_SKIP_CLI_TOOLS')) {
    console.log('[jaw:init] CLI tool install skipped (CLI_JAW_SKIP_CLI_TOOLS)');
} else {
    await installCliTools(installOpts);
}

if (skipEnv('CLI_JAW_SKIP_MCP_SERVERS')) {
    console.log('[jaw:init] MCP server install skipped (CLI_JAW_SKIP_MCP_SERVERS)');
} else {
    await installMcpServers(installOpts);
}

if (skipEnv('CLI_JAW_SKIP_SKILL_DEPS')) {
    console.log('[jaw:init] skill dependency install skipped (CLI_JAW_SKIP_SKILL_DEPS)');
} else {
    await installSkillDeps(installOpts);
}

// Record that user setup finished. This home-side marker (not the install-tree
// receipt, which only postinstall/sidecar write) is what clears the blocked-
// postinstall warning even when the global tree is read-only. It carries the
// package version so an upgrade re-triggers verification.
if (!values['dry-run']) {
    try {
        const { writeSetupState } = await import('../../src/core/install-integrity.js');
        const pkgJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
        const pkgJsonAlt = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
        const pkgFile = fs.existsSync(pkgJsonPath) ? pkgJsonPath : pkgJsonAlt;
        const version = (JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { version?: string }).version ?? '0.0.0';
        writeSetupState(JAW_HOME, version);
    } catch (err) {
        console.warn(`[jaw:init] setup-state marker skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
}

console.log(`
  ✅ 설정 완료!

  Working dir : ${workingDir}
  CLI         : ${cli}
  Gateways    : ${messagingEnabledChannels.join(', ') || 'none'}
  Home channel: ${homeChannel}
  Permissions : auto
  Telegram    : ${tgEnabled ? '✅ ' + tgToken.slice(0, 10) + '...' : '❌ off'}
  Discord     : ${dcEnabled ? '✅ ' + dcToken.slice(0, 10) + '...' : '❌ off'}
  Slack       : ${slEnabled ? '✅ ' + slBotToken.slice(0, 10) + '...' + (slAppToken ? '' : ' (outbound only)') : '❌ off'}
  Skills      : ${skillsDir}
  Settings    : ${SETTINGS_PATH}

  다음 단계:
    cli-jaw doctor     설치 상태 진단
    cli-jaw serve      서버 시작
`);
