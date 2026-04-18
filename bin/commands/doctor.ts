/**
 * cli-jaw doctor — Phase 9.4
 * Diagnoses installation and configuration health.
 */
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JAW_HOME, SETTINGS_PATH, DB_PATH, HEARTBEAT_JOBS_PATH, detectCli } from '../../src/core/config.js';
import { detectSharedPathContamination } from '../../lib/mcp-sync.js';
import { classifyClaudeInstall } from '../../src/core/claude-install.js';

const HEARTBEAT_PATH = HEARTBEAT_JOBS_PATH;

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        json: { type: 'boolean', default: false },
        'repair-shared-paths': { type: 'boolean', default: false },
        tcc: { type: 'boolean', default: false },
        fix: { type: 'boolean', default: false },
        prime: { type: 'boolean', default: false },
    },
    strict: false,
});

const results: Array<{ name: string; status: string; detail: string }> = [];

function findBinaryPath(name: string): string | null {
    return detectCli(name).path;
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

function canSudoNonInteractive() {
    if (process.platform !== 'linux') return null;
    try {
        execSync('sudo -n true', { stdio: 'pipe', timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

function getNpmPrefix() {
    try {
        return execSync('npm config get prefix', { encoding: 'utf8', stdio: 'pipe', timeout: 3000 }).trim();
    } catch {
        return null;
    }
}

/** Detect headless server (no display, no desktop environment). */
function isHeadless(): boolean {
    if (process.platform !== 'linux') return false;
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSL();
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
        if (found) {
            if (cli === 'claude') {
                const kind = classifyClaudeInstall(found);
                if (kind === 'node-managed') {
                    return `installed (${found}) — npm/bun build detected; computer-use MCP is safer with native Claude install`;
                }
                if (kind === 'native') {
                    return `installed (${found}) — native install detected`;
                }
            }
            return `installed (${found})`;
        }
        throw new Error('WARN: not installed');
    });
}

// 6a. Active channel
check('Active channel', () => {
    const ch = settings?.channel || 'telegram';
    return ch;
});

// 6b. Telegram
check('Telegram', () => {
    if (!settings?.telegram?.enabled) throw new Error('WARN: disabled');
    const token = settings.telegram.token;
    if (!token || !token.includes(':')) throw new Error('invalid token format');
    return `token=...${token.slice(-6)}`;
});

// 6c. Discord
check('Discord', () => {
    if (!settings?.discord?.enabled) throw new Error('WARN: disabled');
    const token = settings.discord.token;
    if (!token) throw new Error('token missing');
    const guildId = settings.discord.guildId;
    if (!guildId) throw new Error('guild ID missing — set discord.guildId');
    const channelIds = settings.discord.channelIds;
    if (!channelIds?.length) throw new Error('channel IDs missing — set discord.channelIds');
    return `guild=${guildId}, channels=${channelIds.length} (MESSAGE_CONTENT intent required for plain messages)`;
});

// 6d. Channel consistency
check('Channel consistency', () => {
    const ch = (settings as Record<string, any> | null)?.channel || 'telegram';
    if (ch === 'discord' && !settings?.discord?.enabled) {
        throw new Error('WARN: active channel is discord but Discord is not enabled');
    }
    if (ch === 'telegram' && !settings?.telegram?.enabled) {
        throw new Error('WARN: active channel is telegram but Telegram is not enabled');
    }
    return 'consistent';
});

// 7. Skills directory
check('Skills directory', () => {
    const skillsDir = settings?.skillsDir || path.join(JAW_HOME, 'skills');
    if (!fs.existsSync(skillsDir)) throw new Error('WARN: not found');
    return skillsDir;
});

// 7b. Shared path isolation (Issue #58)
check('Shared path isolation', () => {
    const report = detectSharedPathContamination();
    if (report.status === 'clean') return 'clean';
    if (report.status === 'resolved') return 'clean (backup traces preserved for rollback)';
    if (report.status === 'contaminated') {
        if (values['repair-shared-paths']) {
            // Repair: remove cli-jaw symlinks from shared paths only
            // Backup traces are preserved for rollback — not deleted
            let repaired = 0;
            for (const p of report.paths) {
                if (p.isCliJaw && p.isSymlink) {
                    try {
                        fs.unlinkSync(p.path);
                        repaired++;
                        if (!values.json) console.log(`    🔧 removed: ${p.path}`);
                    } catch (e: unknown) {
                        if (!values.json) console.log(`    ❌ failed to remove ${p.path}: ${(e as Error).message}`);
                    }
                }
            }
            return `repaired (${repaired} symlink${repaired !== 1 ? 's' : ''} removed)`;
        }
        throw new Error(`WARN: ${report.summary}\n     Run: jaw doctor --repair-shared-paths`);
    }
    throw new Error(`WARN: ${report.summary}`);
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

if (isWSL()) {
    check('WSL sudo', () => {
        const ready = canSudoNonInteractive();
        if (ready === true) return 'passwordless sudo available';
        throw new Error('WARN: passwordless sudo unavailable — installer can still set up user-space tools, but apt installs may require manual sudo');
    });

    check('npm global prefix', () => {
        const prefix = getNpmPrefix();
        if (!prefix) throw new Error('WARN: npm prefix unavailable');
        fs.accessSync(prefix, fs.constants.W_OK);
        const expected = path.join(os.homedir(), '.local');
        if (prefix === expected) return `${prefix} (user-local)`;
        throw new Error(`WARN: ${prefix} (not user-local — recommended: npm config set prefix ~/.local)`);
    });

    check('OfficeCLI', () => {
        const found = findBinaryPath('officecli') || path.join(os.homedir(), '.local', 'bin', 'officecli');
        if (found && fs.existsSync(found)) return `installed (${found})`;
        throw new Error('WARN: not installed — run: bash "$(npm root -g)/cli-jaw/scripts/install-officecli.sh"');
    });
}

const headless = isHeadless();

if (headless) {
    // Headless server: browser checks are optional, show as INFO instead of WARN
    if (!values.json) {
        console.log('\n  \u2139\ufe0f  Browser checks (optional on headless server):');
        console.log('     Display Server: skipped (headless)');
        console.log('     playwright-core: skipped (headless)');
        console.log('     Google Chrome: skipped (headless)');
    }
    results.push(
        { name: 'Display Server', status: 'info', detail: 'headless server \u2014 skipped' },
        { name: 'playwright-core', status: 'info', detail: 'headless server \u2014 skipped' },
        { name: 'Google Chrome', status: 'info', detail: 'headless server \u2014 skipped' },
    );
} else {
    if (process.platform === 'linux') {
        check('Display Server', () => {
            if (process.env.WAYLAND_DISPLAY) return `Wayland (${process.env.WAYLAND_DISPLAY})`;
            if (process.env.DISPLAY) return `X11 (${process.env.DISPLAY})`;
            if (isWSL()) {
                if (hasWslWindowsChrome()) {
                    return 'WSL (no DISPLAY; Windows Chrome path detected via /mnt/c)';
                }
                throw new Error('WARN: no DISPLAY in WSL \u2014 enable WSLg/set DISPLAY, or install Windows Chrome for /mnt/c fallback');
            }
            throw new Error('WARN: no DISPLAY \u2014 browser skill needs X11/Wayland');
        });
    }

    check('playwright-core', () => {
        // Check global install via npm root -g (more reliable than require.resolve for global packages)
        try {
            const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: 'pipe' }).trim();
            if (fs.existsSync(path.join(globalRoot, 'playwright-core'))) return 'installed (global)';
        } catch { /* npm not available or error */ }
        // Fallback: check require.resolve (works for local installs)
        try {
            execSync('node -e "require.resolve(\'playwright-core\')"', { stdio: 'pipe' });
            return 'installed';
        } catch {
            throw new Error('WARN: not installed \u2014 run: npm i -g playwright-core');
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
        throw new Error('WARN: not found \u2014 required for browser skill');
    });
}

// ─── macOS TCC diagnostics ──────────────────────────
async function runTccDiagnostics(_opts: { fix: boolean; prime: boolean }) {
    if (process.platform !== 'darwin') return;

    const { readTccAppleEventsGrants } = await import('../../src/core/tcc.js');

    if (!values.json) console.log('\n  🔐 TCC 진단\n');

    check('TCC AppleEvents grants', () => {
        const grants = readTccAppleEventsGrants();
        if (grants.length === 0) return 'empty (run jaw serve from Terminal to trigger prompts)';
        const denied = grants.filter(g => g.authValue === 0);
        const allowed = grants.filter(g => g.authValue === 2);
        let detail = `allowed=${allowed.length}, denied=${denied.length}`;
        if (denied.length > 0) {
            detail += `\n     거부: ${denied.map(d => d.client).join(', ')}`;
            detail += `\n     복구: tccutil reset AppleEvents`;
        }
        return detail;
    });

    check('Codex CLI', () => {
        const binPath = findBinaryPath('codex');
        if (!binPath) throw new Error('WARN: codex 미설치 — npm i -g @openai/codex');
        try {
            const ver = execSync(`${binPath} --version`, { encoding: 'utf8', stdio: 'pipe' }).trim();
            return ver || binPath;
        } catch {
            return binPath;
        }
    });

    if (!values.json) {
        console.log('\n  ℹ️  Computer Use는 Terminal responsibility로 동작합니다.');
        console.log('     Terminal에서 직접 `jaw serve` 실행 시 AppleEvents 권한이 상속됩니다.\n');
    }
}

// Build Discord status for JSON output
function buildDiscordStatus() {
    const s = settings as Record<string, any> | null;
    const dc = s?.discord || {};
    const tokenPresent = !!dc.token;
    const guildConfigured = !!dc.guildId;
    const channelIdsConfigured = !!(dc.channelIds?.length);
    let status = 'ok';
    const degradedReasons: string[] = [];
    if (!dc.enabled) { status = 'disabled'; }
    else if (!tokenPresent) { status = 'missing_token'; degradedReasons.push('token missing'); }
    else if (!guildConfigured) { status = 'missing_guild_id'; degradedReasons.push('guild ID not configured'); }
    else if (!channelIdsConfigured) { status = 'missing_channel_ids'; degradedReasons.push('channel IDs not configured'); }
    // Check active channel consistency
    const activeChannel = s?.channel || 'telegram';
    const channelConsistent = activeChannel !== 'discord' || !!dc.enabled;
    if (!channelConsistent) {
        degradedReasons.push('active channel is discord but Discord is not enabled');
    }

    return {
        status,
        enabled: !!dc.enabled,
        tokenPresent,
        guildConfigured,
        channelIdsConfigured,
        channelConsistent,
        runtimeReady: status === 'ok' && channelConsistent,
        messageContentNote: 'MESSAGE_CONTENT privileged intent required for plain guild messages; without it only slash commands work',
        degradedReasons,
    };
}

// macOS TCC diagnostics (--tcc, --fix, --prime)
if (process.platform === 'darwin' && (values.tcc || values.fix || values.prime)) {
    await runTccDiagnostics({ fix: !!values.fix, prime: !!values.prime });
}

// Output
// Network
if (!values.json) {
    const netCfg = (settings as Record<string, any> | null)?.network || {};
    const bh = netCfg.bindHost || '127.0.0.1';
    const lb = netCfg.lanBypass === true;
    const tokenEnv = !!process.env.JAW_AUTH_TOKEN;
    const isLoopback = bh === '127.0.0.1' || bh === '::1' || bh === 'localhost';
    const bindLabel = isLoopback ? '  (loopback only — LAN blocked)'
        : bh === '0.0.0.0' ? '  (all interfaces — LAN accessible)'
        : `  (interface ${bh} — LAN may be accessible)`;
    console.log('\n  Network');
    console.log(`    bindHost          : ${bh}${bindLabel}`);
    console.log(`    lanBypass         : ${lb}`);
    console.log(`    JAW_AUTH_TOKEN env: ${tokenEnv ? 'persisted' : 'ephemeral (regenerated each start)'}`);
    if (lb && isLoopback) {
        console.log(`    ⚠️  lanBypass is true but bindHost is ${bh} (loopback) — LAN devices cannot connect`);
        console.log('      Fix: set network.bindHost to "0.0.0.0" in settings.json, or use: cli-jaw serve --lan');
    }
    if (bh === '0.0.0.0' && !lb) {
        console.log('    ℹ️  bindHost=0.0.0.0 without lanBypass: LAN clients need Bearer token');
    }
}

if (values.json) {
    const netCfg = (settings as Record<string, any> | null)?.network || {};
    const bh = netCfg.bindHost || '127.0.0.1';
    const lb = netCfg.lanBypass === true;
    const networkIssues: string[] = [];
    const isLoopbackJson = bh === '127.0.0.1' || bh === '::1' || bh === 'localhost';
    if (lb && isLoopbackJson) networkIssues.push('lanBypass enabled but bindHost is loopback');
    if (!isLoopbackJson && bh !== '0.0.0.0') {
        networkIssues.push(`bindHost=${bh} — specific interface, LAN accessibility depends on routing`);
    }
    const output: Record<string, any> = {
        checks: results,
        network: { bindHost: bh, lanBypass: lb, authTokenPersisted: !!process.env.JAW_AUTH_TOKEN, issues: networkIssues },
        activeChannel: (settings as Record<string, any> | null)?.channel || 'telegram',
        discord: buildDiscordStatus(),
        wsl: isWSL() ? {
            sudoNonInteractive: canSudoNonInteractive(),
            npmPrefix: getNpmPrefix(),
            windowsChromeFallback: hasWslWindowsChrome(),
        } : null,
    };
    console.log(JSON.stringify(output, null, 2));
}

const hasError = results.some(r => r.status === 'error');
if (!values.json) {
    console.log(`\n  ${hasError ? '❌ Issues found' : '✅ All good!'}\n`);
}

process.exitCode = hasError ? 1 : 0;
