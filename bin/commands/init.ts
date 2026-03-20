/**
 * cli-jaw init — Phase 9.3
 * Interactive setup wizard or --non-interactive flag mode.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JAW_HOME, SETTINGS_PATH } from '../../src/core/config.js';

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
        'skills-dir': { type: 'string' },
    },
    strict: true,
});

if (values.help) {
    console.log(`Usage: jaw init [options]

Options:
  --help                Show this help
  --non-interactive     Skip prompts, use defaults
  --safe                Safe install (home dir only)
  --dry-run             Show what would be done without changes
  --force               Overwrite existing settings
  --working-dir <path>  Set working directory
  --cli <name>          Default CLI (claude, codex, gemini, copilot, opencode)
  --channel <ch>        Active channel (telegram or discord)
  --telegram-token <t>  Telegram bot token
  --allowed-chat-ids <ids>  Comma-separated Telegram chat IDs
  --discord-token <t>   Discord bot token
  --discord-guild-id <id>   Discord guild (server) ID
  --discord-channel-ids <ids>  Comma-separated Discord channel IDs
  --skills-dir <path>   Skills directory`);
    process.exit(0);
}

// Ensure home dir
fs.mkdirSync(JAW_HOME, { recursive: true });

// Load existing settings — fail if exists and no --force
let settings: Record<string, any> = {};
const settingsExist = fs.existsSync(SETTINGS_PATH);
if (settingsExist && !values.force) {
    console.error('  ❌ settings.json already exists. Use --force to overwrite.');
    process.exit(1);
}
if (settingsExist) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string, def: string): Promise<string> => new Promise(r => {
    if (values['non-interactive']) { r(def); return; }
    rl.question(`  ${q} [${def}]: `, (ans) => r(ans.trim() || def));
});

console.log('\n  🦈 cli-jaw 초기 설정\n');

// Collect
const workingDir = values['working-dir'] ||
    await ask('Working directory', settings.workingDir || JAW_HOME);
const cli = values.cli ||
    await ask('CLI (claude/codex/gemini)', settings.cli || 'claude');

// Channel selection
const channelFlag = values.channel as string | undefined;
if (channelFlag && channelFlag !== 'telegram' && channelFlag !== 'discord') {
    console.error(`  ❌ Invalid --channel "${channelFlag}". Must be "telegram" or "discord".`);
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
        dcGuildId = values['discord-guild-id'] || '';
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
const skillsDir = values['skills-dir'] ||
    await ask('Skills directory', settings.skillsDir || path.join(JAW_HOME, 'skills'));

rl.close();

// Determine active channel
let activeChannel: string = channelFlag || settings.channel || 'telegram';
if (!channelFlag) {
    if (dcEnabled && !tgEnabled) activeChannel = 'discord';
    else if (tgEnabled && !dcEnabled) activeChannel = 'telegram';
}

// Merge (preserve existing values unless --force)
const merged: Record<string, any> = values.force ? {} : { ...settings };
merged.workingDir = workingDir;
merged.cli = cli;
merged.permissions = 'auto';
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
await installMcpServers(installOpts);
await installSkillDeps(installOpts);

console.log(`
  ✅ 설정 완료!

  Working dir : ${workingDir}
  CLI         : ${cli}
  Channel     : ${activeChannel}
  Permissions : auto
  Telegram    : ${tgEnabled ? '✅ ' + tgToken.slice(0, 10) + '...' : '❌ off'}
  Discord     : ${dcEnabled ? '✅ ' + dcToken.slice(0, 10) + '...' : '❌ off'}
  Skills      : ${skillsDir}
  Settings    : ${SETTINGS_PATH}

  다음 단계:
    cli-jaw doctor     설치 상태 진단
    cli-jaw serve      서버 시작
`);
