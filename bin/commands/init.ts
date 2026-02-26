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
        'non-interactive': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        'working-dir': { type: 'string' },
        cli: { type: 'string' },
        permissions: { type: 'string' },
        'telegram-token': { type: 'string' },
        'allowed-chat-ids': { type: 'string' },
        'skills-dir': { type: 'string' },
    },
    strict: false,
});

// Ensure home dir
fs.mkdirSync(JAW_HOME, { recursive: true });

// Load existing settings (merge)
let settings: Record<string, any> = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { }

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string, def: string): Promise<string> => new Promise(r => {
    if (values['non-interactive']) { r(def); return; }
    rl.question(`  ${q} [${def}]: `, (ans) => r(ans.trim() || def));
});

console.log('\n  🦈 cli-jaw 초기 설정\n');

// Collect
const workingDir = values['working-dir'] ||
    await ask('Working directory', settings.workingDir || path.join(os.homedir(), '.cli-jaw'));
const cli = values.cli ||
    await ask('CLI (claude/codex/gemini)', settings.cli || 'claude');
const permissions = values.permissions ||
    await ask('Permissions (safe/auto)', settings.permissions || 'safe');

// Telegram
let tgEnabled = false, tgToken = '', tgChatIds: number[] = [];
if (values['non-interactive']) {
    if (values['telegram-token']) {
        tgEnabled = true;
        tgToken = values['telegram-token'] as string;
        tgChatIds = ((values['allowed-chat-ids'] || '') as string).split(',').map((s: string) => +s.trim()).filter(Boolean);
    }
} else {
    const tgAnswer = await ask('Telegram 연결? (y/n)', settings.telegram?.enabled ? 'y' : 'n');
    tgEnabled = tgAnswer.toLowerCase() === 'y';
    if (tgEnabled) {
        tgToken = await ask('Bot token', settings.telegram?.token || '');
        const idsStr = await ask('Chat IDs (comma)',
            (settings.telegram?.allowedChatIds || []).join(',') || '');
        tgChatIds = idsStr.split(',').map((s: string) => +s.trim()).filter(Boolean);
    }
}

// Skills dir
const skillsDir = values['skills-dir'] ||
    await ask('Skills directory', settings.skillsDir || path.join(JAW_HOME, 'skills'));

rl.close();

// Merge (preserve existing values unless --force)
const merged: Record<string, any> = values.force ? {} : { ...settings };
merged.workingDir = workingDir;
merged.cli = cli;
merged.permissions = permissions;
merged.skillsDir = skillsDir;
if (tgEnabled || values.force) {
    merged.telegram = { enabled: tgEnabled, token: tgToken, allowedChatIds: tgChatIds };
}

// Save
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));

// Ensure skills dir + heartbeat.json
fs.mkdirSync(skillsDir as string, { recursive: true });
const hbPath = path.join(JAW_HOME, 'heartbeat.json');
if (!fs.existsSync(hbPath)) {
    fs.writeFileSync(hbPath, JSON.stringify({ jobs: [] }, null, 2));
}

// Run postinstall symlinks
try {
    await import('../postinstall.js');
} catch (e) {
    console.log(`  ⚠️ Symlink setup: ${(e as Error).message}`);
}

console.log(`
  ✅ 설정 완료!

  Working dir : ${workingDir}
  CLI         : ${cli}
  Permissions : ${permissions}
  Telegram    : ${tgEnabled ? '✅ ' + tgToken.slice(0, 10) + '...' : '❌ off'}
  Skills      : ${skillsDir}
  Settings    : ${SETTINGS_PATH}

  다음 단계:
    cli-jaw doctor     설치 상태 진단
    cli-jaw serve      서버 시작
`);
