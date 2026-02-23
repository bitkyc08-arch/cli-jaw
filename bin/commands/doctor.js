/**
 * cli-claw doctor — Phase 9.4
 * Diagnoses installation and configuration health.
 */
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAW_HOME = path.join(os.homedir(), '.cli-claw');
const SETTINGS_PATH = path.join(CLAW_HOME, 'settings.json');
const DB_PATH = path.join(CLAW_HOME, 'claw.db');
const HEARTBEAT_PATH = path.join(CLAW_HOME, 'heartbeat.json');

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { json: { type: 'boolean', default: false } },
    strict: false,
});

const results = [];

function check(name, fn) {
    try {
        const detail = fn();
        results.push({ name, status: 'ok', detail: detail || 'OK' });
        if (!values.json) console.log(`  ✅ ${name}: ${detail || 'OK'}`);
    } catch (e) {
        const isWarn = e.message?.startsWith('WARN:');
        const status = isWarn ? 'warn' : 'error';
        const msg = e.message?.replace(/^WARN:\s*/, '') || 'unknown';
        results.push({ name, status, detail: msg });
        if (!values.json) {
            console.log(`  ${isWarn ? '⚠️ ' : '❌'} ${name}: ${msg}`);
        }
    }
}

console.log(!values.json ? '\n  🦞 cli-claw doctor\n' : '');

// 1. Home directory
check('Home directory', () => {
    fs.accessSync(CLAW_HOME, fs.constants.W_OK);
    return CLAW_HOME;
});

// 2. settings.json
let settings = null;
check('settings.json', () => {
    if (!fs.existsSync(SETTINGS_PATH)) throw new Error('WARN: not found — run cli-claw init');
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return `cli=${settings.cli || 'not set'}`;
});

// 3. Database
check('claw.db', () => {
    if (!fs.existsSync(DB_PATH)) throw new Error('WARN: not found — will be created on first serve');
    const stat = fs.statSync(DB_PATH);
    return `${(stat.size / 1024).toFixed(0)} KB`;
});

// 4. heartbeat.json
check('heartbeat.json', () => {
    if (!fs.existsSync(HEARTBEAT_PATH)) throw new Error('WARN: not found');
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
    const active = (hb.jobs || []).filter(j => j.enabled).length;
    return `${active} active job${active !== 1 ? 's' : ''}`;
});

// 5. CLI tools
for (const cli of ['claude', 'codex', 'gemini', 'opencode']) {
    check(`CLI: ${cli}`, () => {
        try {
            execSync(`which ${cli}`, { stdio: 'pipe' });
            return 'installed';
        } catch {
            throw new Error('WARN: not installed');
        }
    });
}

// 6. Telegram
check('Telegram', () => {
    if (!settings?.telegram?.enabled) throw new Error('WARN: disabled');
    const token = settings.telegram.token;
    if (!token || !token.includes(':')) throw new Error('invalid token format');
    return `token=...${token.slice(-6)}`;
});

// 7. Skills symlink
check('Skills directory', () => {
    const skillsDir = settings?.skillsDir || path.join(CLAW_HOME, 'skills');
    if (!fs.existsSync(skillsDir)) throw new Error('WARN: not found');
    const agentsSkills = path.join(os.homedir(), '.agents', 'skills');
    const hasSymlink = fs.existsSync(agentsSkills);
    return hasSymlink ? `${skillsDir} (symlinked)` : `${skillsDir} (no symlink)`;
});

// 8. macOS Accessibility (Phase 260223)
if (process.platform === 'darwin') {
    check('macOS Accessibility', () => {
        try {
            execSync('osascript -e "tell application \\"System Events\\" to return name of first process"', {
                stdio: 'pipe', timeout: 5000,
            });
            return 'granted';
        } catch {
            // Auto-open System Preferences
            try {
                execSync('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"', { stdio: 'pipe' });
            } catch { }
            throw new Error('WARN: 접근성 권한 필요 → 시스템 설정을 열었습니다. Terminal을 추가해주세요');
        }
    });
}

// Output
if (values.json) {
    console.log(JSON.stringify({ checks: results }, null, 2));
}

const hasError = results.some(r => r.status === 'error');
if (!values.json) {
    console.log(`\n  ${hasError ? '❌ Issues found' : '✅ All good!'}\n`);
}

process.exitCode = hasError ? 1 : 0;
