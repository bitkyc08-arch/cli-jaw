/**
 * cli-jaw init — Phase 9.3
 * Interactive setup wizard or --non-interactive flag mode.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import fs from 'node:fs';

import path from 'node:path';
import { JAW_HOME, SETTINGS_PATH } from '../../src/core/config.js';
import { CLI_KEYS } from '../../src/cli/registry.js';

const CLI_CHOICES = CLI_KEYS.join(', ');

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
  --channel <ch>        Active channel (telegram, discord, or slack)
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
if (channelFlag && channelFlag !== 'telegram' && channelFlag !== 'discord' && channelFlag !== 'slack') {
    console.error(`  ❌ Invalid --channel "${channelFlag}". Must be "telegram", "discord", or "slack".`);
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
} else if (!channelFlag || channelFlag === 'telegram') {
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
} else if (!channelFlag || channelFlag === 'discord') {
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
if (values['non-interactive']) {
    if (values['slack-bot-token']) {
        slBotToken = values['slack-bot-token'] as string;
        slAppToken = String(values['slack-app-token'] || '');
        slTeamId = String(values['slack-team-id'] || '');
        slChannelIds = ((values['slack-channel-ids'] || '') as string).split(',').map(s => s.trim()).filter(Boolean);
        slEnabled = true;
    }
} else if (!channelFlag || channelFlag === 'slack') {
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
if (channelFlag === 'discord' && !dcEnabled) {
    console.error('  ❌ --channel discord requires --discord-token.');
    process.exit(1);
}

// Validate: --channel slack requires at least the bot token
if (channelFlag === 'slack' && !slEnabled) {
    console.error('  ❌ --channel slack requires --slack-bot-token.');
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

// Determine active channel
let activeChannel: string = channelFlag || settings.channel || 'telegram';
if (!channelFlag) {
    // Only infer when exactly one channel is configured; two or more leaves
    // the existing value alone rather than silently picking one.
    if (dcEnabled && !tgEnabled && !slEnabled) activeChannel = 'discord';
    else if (tgEnabled && !dcEnabled && !slEnabled) activeChannel = 'telegram';
    else if (slEnabled && !tgEnabled && !dcEnabled) activeChannel = 'slack';
}

// Merge (preserve existing values unless --force)
const merged: InitSettings = values.force ? {} : { ...settings };
merged.workingDir = workingDir;
merged.cli = cli;
merged["permissions"] = 'auto';
merged.skillsDir = skillsDir;
merged.channel = activeChannel;
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
if (slEnabled || values.force) {
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

await installCliTools(installOpts);

// The two skip switches were honoured by the npm postinstall path only, so
// `jaw init` reached for the network regardless. That is what made the init
// behavior suite hang on CI: a runner has neither `uv` nor `playwright-core`,
// so every one of its six subprocesses tried to fetch and install them, and
// the step hit its three-minute limit before the first assertion printed.
//
// Same variables, same spelling, now honoured wherever the installers are
// driven from.
const skipEnv = (name: string) => process.env[name] === '1' || process.env[name] === 'true';

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

console.log(`
  ✅ 설정 완료!

  Working dir : ${workingDir}
  CLI         : ${cli}
  Channel     : ${activeChannel}
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
