/**
 * cli-jaw doctor — Phase 9.4
 * Diagnoses installation and configuration health.
 */
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JAW_HOME, SETTINGS_PATH, DB_PATH, HEARTBEAT_JOBS_PATH } from '../../src/core/config.js';

const HEARTBEAT_PATH = HEARTBEAT_JOBS_PATH;
const PATH_LOOKUP_CMD = process.platform === 'win32' ? 'where' : 'which';

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { json: { type: 'boolean', default: false } },
    strict: false,
});

const results: Array<{ name: string; status: string; detail: string }> = [];

function findBinaryPath(name: string): string | null {
    try {
        const out = execSync(`${PATH_LOOKUP_CMD} ${name}`, { encoding: 'utf8', stdio: 'pipe', timeout: 3000 }).trim();
        const first = out.split(/\r?\n/).map(x => x.trim()).find(Boolean);
        return first || null;
    } catch {
        return null;
    }
}

function isWSL() {
    if (process.platform !== 'linux') return false;
    try {
        return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    } catch {
        return false;
    }
}

function hasWslWindowsChrome() {
    const paths = [
        '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
        '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
    return paths.some(p => fs.existsSync(p));
}

function check(name: string, fn: () => string) {
    try {
        const detail = fn();
        results.push({ name, status: 'ok', detail: detail || 'OK' });
        if (!values.json) console.log(`  ✅ ${name}: ${detail || 'OK'}`);
    } catch (e) {
        const isWarn = (e as Error).message?.startsWith('WARN:');
        const status = isWarn ? 'warn' : 'error';
        const msg = (e as Error).message?.replace(/^WARN:\s*/, '') || 'unknown';
        results.push({ name, status, detail: msg });
        if (!values.json) {
            console.log(`  ${isWarn ? '⚠️ ' : '❌'} ${name}: ${msg}`);
        }
    }
}

console.log(!values.json ? '\n  🦈 cli-jaw doctor\n' : '');

// 1. Home directory
check('Home directory', () => {
    if (!fs.existsSync(JAW_HOME)) {
        fs.mkdirSync(JAW_HOME, { recursive: true });
    }
    fs.accessSync(JAW_HOME, fs.constants.W_OK);
    return JAW_HOME;
});

// 2. settings.json
let settings: Record<string, any> | null = null;
check('settings.json', () => {
    if (!fs.existsSync(SETTINGS_PATH)) throw new Error('WARN: not found — run cli-jaw init');
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return `cli=${settings?.cli || 'not set'}`;
});

// 3. Database
check('jaw.db', () => {
    if (!fs.existsSync(DB_PATH)) throw new Error('WARN: not found — will be created on first serve');
    const stat = fs.statSync(DB_PATH);
    return `${(stat.size / 1024).toFixed(0)} KB`;
});

// 4. heartbeat.json
check('heartbeat.json', () => {
    if (!fs.existsSync(HEARTBEAT_PATH)) throw new Error('WARN: not found');
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
    const active = (hb.jobs || []).filter((j: any) => j.enabled).length;
    return `${active} active job${active !== 1 ? 's' : ''}`;
});

// 5. CLI tools
for (const cli of ['claude', 'codex', 'gemini', 'opencode', 'copilot']) {
    check(`CLI: ${cli}`, () => {
        const found = findBinaryPath(cli);
        if (found) return `installed (${found})`;
        throw new Error('WARN: not installed');
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
    const skillsDir = settings?.skillsDir || path.join(JAW_HOME, 'skills');
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

if (process.platform === 'linux') {
    check('Display Server', () => {
        if (process.env.WAYLAND_DISPLAY) return `Wayland (${process.env.WAYLAND_DISPLAY})`;
        if (process.env.DISPLAY) return `X11 (${process.env.DISPLAY})`;
        if (isWSL()) {
            if (hasWslWindowsChrome()) {
                return 'WSL (no DISPLAY; Windows Chrome path detected via /mnt/c)';
            }
            throw new Error('WARN: no DISPLAY in WSL — enable WSLg/set DISPLAY, or install Windows Chrome for /mnt/c fallback');
        }
        throw new Error('WARN: no DISPLAY — browser skill needs X11/Wayland');
    });
}

// 9. Skill dependencies (Phase 9)
check('uv (Python)', () => {
    try {
        const ver = execSync('uv --version', { encoding: 'utf8', stdio: 'pipe' }).trim();
        return ver;
    } catch {
        const installHint = process.platform === 'win32'
            ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
            : 'curl -LsSf https://astral.sh/uv/install.sh | sh';
        throw new Error(`WARN: not installed — run: ${installHint}`);
    }
});

check('playwright-core', () => {
    try {
        execSync('node -e "require.resolve(\'playwright-core\')"', { stdio: 'pipe' });
        return 'installed';
    } catch {
        throw new Error('WARN: not installed — run: npm i -g playwright-core');
    }
});

check('Google Chrome', () => {
    if (process.platform === 'darwin') {
        if (fs.existsSync('/Applications/Google Chrome.app')) return 'installed';
        if (fs.existsSync(path.join(os.homedir(), 'Applications/Google Chrome.app'))) return 'installed (user)';
    } else if (process.platform === 'win32') {
        const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
        const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const local = process.env.LOCALAPPDATA || '';
        const winPaths = [
            `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
            `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
            `${local}\\Google\\Chrome\\Application\\chrome.exe`,
            `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        ];
        for (const p of winPaths) {
            if (p && fs.existsSync(p)) return 'installed';
        }
    } else {
        const linuxPaths = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/brave-browser',
            '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
            '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        ];
        for (const p of linuxPaths) {
            if (fs.existsSync(p)) return 'installed';
        }
    }
    throw new Error('WARN: not found — required for browser skill');
});

// Output
if (values.json) {
    console.log(JSON.stringify({ checks: results }, null, 2));
}

const hasError = results.some(r => r.status === 'error');
if (!values.json) {
    console.log(`\n  ${hasError ? '❌ Issues found' : '✅ All good!'}\n`);
}

process.exitCode = hasError ? 1 : 0;
