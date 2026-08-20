/**
 * cli-jaw doctor — Phase 9.4
 * Diagnoses installation and configuration health.
 */
import { parseArgs } from 'node:util';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JAW_HOME, SETTINGS_PATH, DB_PATH, HEARTBEAT_JOBS_PATH, detectCli } from '../../src/core/config.js';
import { slackChannelScope } from '../../src/slack/scope-status.js';
import { checkPsExecutionPolicy, inspectInstallIntegrity, formatRecoveryCommands } from '../../src/core/install-integrity.js';
import { detectSharedPathContamination } from '../../lib/mcp-sync.js';
import { migrateAllJawHomes, hasPendingLegacySkillDirs, discoverJawHomes } from '../../lib/mcp/skills-migration.js';
import { isDiscoverableSkillDirName } from '../../lib/mcp/skills-utils.js';
import { classifyClaudeInstall } from '../../src/core/claude-install.js';
import { isWsl, isWindowsNative, resolvePlatformKind } from '../../src/core/platform-kind.js';
import { readClaudeCreds } from '../../src/routes/quota.js';
import { CLI_KEYS } from '../../src/cli/registry.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { asArray, asRecord } from '../_http-client.js';
import { getEnabledChannels, getHomeChannel } from '../../src/messaging/runtime.js';


if (shouldShowHelp(process.argv)) printAndExit(`
  jaw doctor — diagnose installation and configuration

  Usage: jaw doctor [--json]

  Checks:
    - Node.js version and path
    - CLI binary resolution
    - Settings file validity
    - MCP server connectivity
    - Employee CLI availability
    - Port availability

  Options:
    --json    Machine-readable diagnostic output
`);

const HEARTBEAT_PATH = HEARTBEAT_JOBS_PATH;

interface MessagingSettings {
    enabled?: boolean;
    token?: string;
}

interface DiscordSettings extends MessagingSettings {
    guildId?: string;
    channelIds?: unknown[];
}

// Slack does NOT extend MessagingSettings: that interface's single credential
// is `token`, while Slack needs two distinctly-scoped tokens.
interface SlackSettings {
    enabled?: boolean;
    botToken?: string;
    appToken?: string;
    teamId?: string;
    channelIds?: unknown[];
    attachPort?: string;
}

interface NetworkSettings {
    bindHost?: string;
    lanBypass?: boolean;
    remoteAccess?: {
        mode?: string;
        trustProxies?: boolean;
        trustForwardedFor?: boolean;
        requireAuth?: boolean;
    };
}

interface DoctorSettings {
    cli?: string;
    /** @deprecated v3 alias, kept for one major as a read-only fallback. */
    channel?: string;
    messaging?: {
        enabledChannels?: unknown[];
        homeChannel?: string;
        [k: string]: unknown;
    };
    skillsDir?: string;
    telegram?: MessagingSettings;
    discord?: DiscordSettings;
    slack?: SlackSettings;
    network?: NetworkSettings;
    /**
     * Watchdog deadlines. Per-CLI blocks live under the same object keyed by CLI
     * name (`agentTimeout.cursor.absoluteMs`) and override the top level, which
     * is why the index signature is here.
     */
    agentTimeout?: {
        absoluteMs?: number;
        firstProgressMs?: number;
        idleMs?: number;
        absoluteHardCapMs?: number;
        [cli: string]: unknown;
    };
}

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

function rejectedCliDetail(name: string): string {
    const rejected = detectCli(name).rejected || [];
    if (!rejected.length) return '';
    const detail = rejected
        .slice(0, 2)
        .map((entry) => `${entry.path} (${entry.reason})`)
        .join('; ');
    return `; skipped non-spawnable candidate${rejected.length > 1 ? 's' : ''}: ${detail}`;
}

function isWSL() {
    return isWsl();
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

function verifyOfficeCli(): { status: 'ok' | 'info' | 'warn'; detail: string } {
    const candidates = [
        findBinaryPath('officecli'),
        path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'officecli.exe' : 'officecli'),
        process.platform === 'win32' && process.env['LOCALAPPDATA']
            ? path.join(process.env['LOCALAPPDATA'], 'OfficeCli', 'officecli.exe')
            : null,
    ].filter((candidate): candidate is string => !!candidate);
    const candidate = candidates.find((entry) => fs.existsSync(entry));
    if (!candidate || !fs.existsSync(candidate)) {
        const installHint = process.platform === 'win32'
            ? 'powershell -ExecutionPolicy Bypass -File "$(npm root -g)\\cli-jaw\\scripts\\install-officecli.ps1" -Update'
            : 'bash "$(npm root -g)/cli-jaw/scripts/install-officecli.sh"';
        return { status: 'info', detail: `not installed (optional — install on-demand: ${installHint})` };
    }
    try {
        const version = execFileSync(candidate, ['--version'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 5000,
        }).trim();
        return { status: 'ok', detail: `installed (${candidate}) version=${version}` };
    } catch (e: unknown) {
        const message = (e as Error).message || String(e);
        return { status: 'warn', detail: `found but not runnable (${candidate}) — ${message}` };
    }
}

function readBinaryVersion(candidate: string, args: string[] = ['--version']): string {
    return execFileSync(candidate, args, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
    }).trim();
}

function verifyClaudeInteractive() {
    const helper = findBinaryPath('claude-e') || findBinaryPath('claude-exec') || findBinaryPath('jaw-claude-i');
    if (!helper) {
        throw new Error('WARN: runtime missing — install with `jaw provider install claude-e` (needs Rust cargo) or build with `npm run build:claude-exec`');
    }

    let helperVersion = 'unknown';
    try {
        helperVersion = readBinaryVersion(helper);
    } catch (e: unknown) {
        const message = (e as Error).message || String(e);
        throw new Error(`WARN: runtime found but not runnable (${helper}) — ${message}`);
    }

    const claude = findBinaryPath('claude');
    if (!claude) {
        throw new Error(`WARN: runtime=${helper} version=${helperVersion}; underlying claude missing`);
    }

    let claudeVersion = 'unknown';
    try {
        claudeVersion = readBinaryVersion(claude);
    } catch {
        claudeVersion = 'version check failed';
    }

    return `runtime=${helper} version=${helperVersion}; claude=${claude} version=${claudeVersion}; provider=claude-e`;
}

function verifyAiE() {
    const helper = findBinaryPath('ai-e');
    if (!helper) {
        throw new Error(`WARN: runtime missing — install \`ai-e\` on PATH or set AI_E_BIN${rejectedCliDetail('ai-e')}`);
    }

    let helperVersion = 'unknown';
    try {
        helperVersion = readBinaryVersion(helper);
    } catch (e: unknown) {
        const message = (e as Error).message || String(e);
        throw new Error(`WARN: runtime found but not runnable (${helper}) — ${message}`);
    }

    try {
        const help = execFileSync(helper, ['--help'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 5000,
        });
        if (!/ai-e <provider>/.test(help) || !/codex/.test(help) || !/copilot/.test(help)) {
            throw new Error('provider-first help shape missing');
        }
    } catch (e: unknown) {
        const message = (e as Error).message || String(e);
        throw new Error(`WARN: contract check failed (${helper}) — ${message}`);
    }

    return `runtime=${helper} version=${helperVersion}; providers=claude,codex,gemini,grok,copilot`;
}

/** Detect headless server (no display, no desktop environment). */
function isHeadless(): boolean {
    if (process.platform !== 'linux') return false;
    return !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"] && !isWSL();
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

function resolvePackageRoot(): string {
    // Compiled location is dist/bin/commands/doctor.js, so walk up until the
    // directory actually holding package.json (same fallback as bin/cli-jaw.ts).
    let packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    if (!fs.existsSync(path.join(packageRoot, 'package.json'))) {
        packageRoot = path.join(packageRoot, '..');
    }
    return packageRoot;
}

const require_ = createRequire(import.meta.url);
const { listStaleStaging } = require_(path.join(resolvePackageRoot(), 'scripts', 'staging-cleanup.cjs')) as {
    listStaleStaging(nodeModulesDir: string): string[];
};

console.log(!values.json ? '\n  🦈 cli-jaw doctor\n' : '');

// 1. Home directory
check('Home directory', () => {
    if (!fs.existsSync(JAW_HOME)) {
        fs.mkdirSync(JAW_HOME, { recursive: true });
    }
    fs.accessSync(JAW_HOME, fs.constants.W_OK);
    return JAW_HOME;
});

// 1b. Install scripts — npm >= 12 blocks unreviewed dependency lifecycle
// scripts, so a "successful" global install may have skipped our postinstall.
// The install-state receipt (or the jaw-init setup marker) tells them apart.
check('Install scripts', () => {
    const packageRoot = resolvePackageRoot();
    const integrity = inspectInstallIntegrity(packageRoot, JAW_HOME);
    if (integrity.installScriptState === 'completed') {
        return integrity.userSetupDone ? 'ran (setup complete)' : 'ran';
    }
    if (integrity.installScriptState === 'dev-clone') {
        return 'development clone (receipt not required)';
    }
    if (integrity.userSetupDone) {
        return `install scripts ${integrity.installScriptState} — setup completed manually via jaw init`;
    }
    const commands = formatRecoveryCommands(integrity).join('  |  ');
    throw new Error(`WARN: install scripts ${integrity.installScriptState} — postinstall did not run. Fix: ${commands}  (or run: jaw init)`);
});

check('Stale npm staging', () => {
    const nodeModulesDir = path.join(resolvePackageRoot(), '..');
    const leftovers = listStaleStaging(nodeModulesDir);
    if (!leftovers.length) return 'none';
    throw new Error(`WARN: ${leftovers.join(', ')} — close processes using these directories, then remove them manually from ${nodeModulesDir}`);
});

check('PowerShell execution policy', () => {
    const policy = checkPsExecutionPolicy();
    if (policy.state === 'skipped') return 'skipped (non-win32)';
    if (policy.state === 'unknown') return 'unknown (probe unavailable)';
    if (policy.state === 'warn') {
        throw new Error(`WARN: ${policy.policy} — ${policy.guidance}`);
    }
    return policy.policy || 'ok';
});

// 2. settings.json
let settings: DoctorSettings | null = null;
function loadedSettings(): DoctorSettings {
    return (settings as DoctorSettings | null) || {};
}
check('settings.json', () => {
    if (!fs.existsSync(SETTINGS_PATH)) throw new Error('WARN: not found — run cli-jaw init');
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as DoctorSettings;
    return `cli=${settings?.cli || 'not set'}`;
});

// 2b. settings.json permissions — the file carries live channel tokens
// (xoxb-/xapp-/bot tokens), so group/other-readable is a real leak.
// loadSettings self-heals on the next load; this check surfaces it until then.
check('settings.json permissions', () => {
    if (process.platform === 'win32') return 'skipped (win32)';
    if (!fs.existsSync(SETTINGS_PATH)) throw new Error('WARN: not found');
    const mode = fs.statSync(SETTINGS_PATH).mode & 0o777;
    if (mode & 0o077) throw new Error(`permissions ${mode.toString(8)} — should be 600 (tokens inside); fixed automatically on next settings load`);
    return '600';
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
    const hb = asRecord(JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8')));
    const active = asArray<{ enabled?: boolean }>(hb["jobs"]).filter((j) => j.enabled).length;
    return `${active} active job${active !== 1 ? 's' : ''}`;
});

// 5. CLI tools
for (const cli of CLI_KEYS) {
    if (cli === 'claude-e') {
        check('CLI: claude-e', verifyClaudeInteractive);
        continue;
    }
    if (cli === 'ai-e') {
        check('CLI: ai-e', verifyAiE);
        continue;
    }
    check(`CLI: ${cli}`, () => {
        const found = findBinaryPath(cli);
        const skipped = rejectedCliDetail(cli);
        if (found) {
            if (cli === 'claude') {
                const kind = classifyClaudeInstall(found);
                if (kind === 'node-managed') {
                    return `installed (${found}) — npm/bun build detected; computer-use MCP is safer with native Claude install${skipped}`;
                }
                if (kind === 'native') {
                    return `installed (${found}) — native install detected${skipped}`;
                }
            }
            return `installed (${found})${skipped}`;
        }
        throw new Error('WARN: not installed');
    });
}

check('Claude auth', () => {
    const creds = readClaudeCreds();
    if (!creds) throw new Error('WARN: not authenticated — run: claude auth login');
    const quotaNote = creds.quotaCapable ? 'quota available' : 'quota unavailable for this auth source';
    return `${creds.source} (${quotaNote})`;
});

// 6a. Inbound gateways (legacy check name: Active channel)
check('Inbound gateways', () => {
    const enabled = getEnabledChannels(settings || {});
    if (enabled.length === 0) throw new Error('WARN: no inbound gateways enabled');
    return enabled.join(', ');
});

// 6a-b. Home channel
check('Home channel', () => {
    const home = getHomeChannel(settings || {});
    return home;
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

// 6d. Slack
check('Slack', () => {
    if (!settings?.slack?.enabled) throw new Error('WARN: disabled');
    const botToken = settings.slack.botToken;
    if (!botToken) throw new Error('bot token missing — set slack.botToken or run: jaw slack setup');
    if (!botToken.startsWith('xoxb-')) throw new Error('bot token should start with xoxb-');
    const appToken = settings.slack.appToken;
    // Outbound-only is a legitimate partial configuration, so this is a WARN:
    // the Web API works, but no inbound events can arrive.
    if (!appToken) throw new Error('WARN: app-level token missing — outbound only, no inbound events (jaw slack setup)');
    if (!appToken.startsWith('xapp-')) throw new Error('app token should start with xapp-');
    // One bot, one instance: tokens present here but the socket belongs to
    // another instance — WARN so it reads as intended, not broken.
    const attachPort = String(settings.slack.attachPort || '').trim();
    const thisPort = String(loadedSettings()["port" as keyof DoctorSettings] || '').trim();
    if (attachPort && thisPort && attachPort !== thisPort) {
        throw new Error(`WARN: slack attach instance is :${attachPort} — this instance (:${thisPort}) must not connect`);
    }
    // Read through the same helper the gate uses, or this line reports a reach
    // the bot does not have (#406).
    const { ids, scope } = slackChannelScope(settings.slack.channelIds);
    if (scope === 'malformed') {
        throw new Error('WARN: slack.channelIds is not a list of conversation ids — '
            + 'every channel is being denied. Set it to [] to allow all conversations.');
    }
    if (scope === 'all_conversations') {
        return `bot=...${botToken.slice(-6)}, app=...${appToken.slice(-6)}, 모든 대화 허용`;
    }
    return `bot=...${botToken.slice(-6)}, app=...${appToken.slice(-6)}, `
        + `${ids.length}개 대화만 허용 (${ids.join(', ')}) — 이 밖의 대화는 무시됩니다`;
});

// 6e. Channel consistency
check('Channel consistency', () => {
    const enabled = getEnabledChannels(settings || {});
    if (enabled.length === 0) return 'no enabled channels';
    const issues: string[] = [];
    for (const ch of enabled) {
        if (ch === 'telegram' && !settings?.telegram?.enabled) {
            issues.push('active channel is telegram but Telegram is not enabled');
        }
        if (ch === 'discord' && !settings?.discord?.enabled) {
            issues.push('active channel is discord but Discord is not enabled');
        }
        if (ch === 'slack' && !settings?.slack?.enabled) {
            issues.push('active channel is slack but Slack is not enabled');
        }
    }
    if (issues.length > 0) {
        throw new Error(`WARN: ${issues.join('; ')}`);
    }
    return 'consistent';
});

// 6f. Agent watchdog deadline
check('에이전트 타임아웃', () => {
    // Only `settings.cli` is knowable here. When it is unset the runtime picks
    // the first ready CLI at load time — and falls back to claude on an
    // unreadable file — neither of which this process can reproduce without
    // probing every runtime. Naming DEFAULT_CLI anyway would report a per-CLI
    // override for a CLI that may never run. So the unset case answers about the
    // global setting and says which CLI it would need to be sure.
    const activeCli = settings?.cli || '';
    // Mirrors the runtime merge in src/agent/spawn.ts, both typeof guards
    // included: these values come from raw settings JSON, where either level can
    // be something other than an object.
    const raw = (settings as Record<string, unknown> | undefined)?.['agentTimeout'];
    const gCfg = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const cRaw = activeCli ? gCfg[activeCli] : undefined;
    const cCfg = cRaw && typeof cRaw === 'object' ? cRaw as Record<string, unknown> : {};
    const merged = { ...gCfg, ...cCfg };
    // Not `abs ? a : b`: a configured 0 would report as the default. The runtime
    // does not clamp it, so doctor should not pretend it is unset.
    const abs = typeof merged['absoluteMs'] === 'number' ? merged['absoluteMs'] : undefined;
    // The watchdog ends a turn that stops reporting progress. Nothing told the
    // operator this was tunable, so a 933s research turn read as the model
    // giving up (#405). Reading the per-CLI override matters: an instance with
    // only `agentTimeout.cursor.absoluteMs` set would otherwise be told "600s
    // default", which is false.
    const perCli = Object.keys(gCfg).filter(k => CLI_KEYS.includes(k as never));
    const suffix = activeCli
        ? `${activeCli} 유효값, settings.agentTimeout`
        : perCli.length > 0
            ? `전역값 — settings.cli 가 없어 실행 CLI를 알 수 없습니다. per-CLI 설정 있음: ${perCli.join(', ')}`
            : '전역값, settings.agentTimeout';
    return abs !== undefined
        ? `${Math.round(abs / 1000)}초 (${suffix})`
        : '600초 (기본값) — settings.agentTimeout.absoluteMs 또는 agentTimeout.<cli>.absoluteMs 로 조정';
});

// 7. Skills directory
check('Skills directory', () => {
    const skillsDir = settings?.skillsDir || path.join(JAW_HOME, 'skills');
    if (!fs.existsSync(skillsDir)) throw new Error('WARN: not found');
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && isDiscoverableSkillDirName(d.name));
    if (entries.length === 0) {
        const refDir = path.join(JAW_HOME, 'skills_ref').replace(/\\/g, '/');
        throw new Error(
            'WARN: skills directory is empty — agents will not work correctly\n'
            + `     Run: git clone --depth 1 https://github.com/lidge-jun/cli-jaw-skills.git "${refDir}"\n`
            + '     Then: jaw skill reset'
        );
    }
    const required = ['jaw-dev', 'jaw-diagram'];
    const missing = required.filter(s => !fs.existsSync(path.join(skillsDir, s, 'SKILL.md')));
    if (missing.length > 0) {
        throw new Error(
            `WARN: missing required skills: ${missing.join(', ')}\n`
            + '     Run: jaw skill reset'
        );
    }
    return `${skillsDir} (${entries.length} active)`;
});

// 7a. jaw-* namespace migration. Active skill ids moved to jaw-* so they stop
// colliding with Codex-native tool names; a home installed before that still
// has real directories at the old names. --fix migrates every home on the box.
check('Skill namespace (jaw-*)', () => {
    if (!hasPendingLegacySkillDirs()) {
        return `${discoverJawHomes(JAW_HOME).length} home(s) on jaw-* ids`;
    }
    if (!values.fix) {
        throw new Error(
            'WARN: legacy skill directories found (pre jaw-* namespace)\n'
            + '     Run: jaw doctor --fix'
        );
    }
    const reports = migrateAllJawHomes();
    const renamed = reports.reduce((n, r) => n + r.result.renamed.length, 0);
    const backedUp = reports.reduce((n, r) => n + r.result.backedUp.length, 0);
    const linked = reports.reduce((n, r) => n + r.result.linked.length, 0);
    return `migrated ${reports.length} home(s): ${renamed} ref renamed, ${backedUp} backed up, ${linked} compat links`;
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
            } catch { } // best-effort: opening System Preferences can fail on headless/CI
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

if (isWindowsNative()) {
    check('Windows (native)', () => {
        return `platform=${resolvePlatformKind()}; npm prefix=${getNpmPrefix() || 'unknown'}`;
    });

    check('CLI tools (Windows-native)', () => {
        // The interesting information is in `rejected`: paths found on PATH
        // that cannot be launched (extensionless POSIX shim, .ps1, missing
        // file). Re-testing an ACCEPTED path would just re-ask a question
        // detectCli already answered yes.
        const unusable: string[] = [];
        for (const name of ['claude', 'codex', 'gemini', 'copilot', 'opencode', 'jaw']) {
            const detected = detectCli(name);
            for (const entry of detected.rejected ?? []) {
                if (entry.reason === 'ENOENT') continue;
                unusable.push(`${name} → ${entry.path} (${entry.reason})`);
            }
        }
        if (unusable.length > 0) {
            throw new Error(
                `WARN: ${unusable.length} candidate(s) found on PATH but not launchable:\n`
                + unusable.map(t => `     ${t}`).join('\n')
                + '\n     Reinstall with: npm i -g <package>'
            );
        }
        return 'all detected CLI tools are Windows-executable';
    });
} else if (isWSL()) {
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

    check('Node.js origin', () => {
        const execPath = process.execPath.replace(/\\/g, '/');
        const isWindowsNode =
            process.platform === 'win32'
            || /^[A-Z]:\//i.test(execPath)
            || execPath.startsWith('/mnt/');
        if (isWindowsNode) {
            throw new Error(
                `WARN: using Windows Node.js (${process.execPath})\n`
                + '     Install Node inside WSL: fnm install 22 (or nvm install 22)'
            );
        }
        return `${process.version} → ${process.execPath}`;
    });

    check('CLI tools (WSL-native)', () => {
        const windowsTools: string[] = [];
        for (const name of ['claude', 'codex', 'gemini', 'copilot', 'opencode', 'jaw']) {
            const detected = detectCli(name);
            if (detected.path?.startsWith('/mnt/')) {
                windowsTools.push(`${name} → ${detected.path}`);
            }
            for (const r of detected.rejected ?? []) {
                if (r.path.startsWith('/mnt/') || r.reason.includes('windows executable')) {
                    windowsTools.push(`${name} → ${r.path} (${r.reason})`);
                }
            }
        }
        if (windowsTools.length > 0) {
            throw new Error(
                `WARN: ${windowsTools.length} tool(s) found via Windows PATH (not usable in WSL):\n`
                + windowsTools.map(t => `     ${t}`).join('\n')
                + '\n     Reinstall inside WSL: npm i -g <package>'
            );
        }
        return 'all detected CLI tools are WSL-native';
    });

    // OfficeCLI — informational only (no longer bundled; installed on-demand)
    {
        const officecli = verifyOfficeCli();
        results.push({ name: 'OfficeCLI', status: officecli.status, detail: officecli.detail });
        if (!values.json) {
            const icon = officecli.status === 'ok' ? '✅' : officecli.status === 'warn' ? '⚠️ ' : 'ℹ️ ';
            console.log(`  ${icon} OfficeCLI: ${officecli.detail}`);
        }
    }
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
            if (process.env["WAYLAND_DISPLAY"]) return `Wayland (${process.env["WAYLAND_DISPLAY"]})`;
            if (process.env["DISPLAY"]) return `X11 (${process.env["DISPLAY"]})`;
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
            const pf = process.env["PROGRAMFILES"] || 'C:\\Program Files';
            const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
            const local = process.env["LOCALAPPDATA"] || '';
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

// ─── Slack OAuth scope drift (#340) ─────────────────
// Asks the RUNNING server rather than Slack directly, on purpose. doctor reads
// the default home while the live instance may have been started with
// --home elsewhere; querying Slack with doctor's own settings would report on
// a config nobody is running. The degraded process is the one serving traffic,
// so its /api/health is the authoritative answer.
async function runSlackScopeDiagnostics(): Promise<void> {
    const s = loadedSettings();
    if (!s?.slack?.enabled) return;
    const port = String(s["port" as keyof DoctorSettings] || '').trim();
    if (!port) return;

    type HealthPayload = {
        channels?: {
            slackScopes?: {
                ok?: boolean; unknown?: boolean;
                missingRequired?: string[]; missingCapabilities?: string[];
                reinstallUrl?: string | null;
            };
        };
    };
    let payload: HealthPayload | null = null;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(3000),
        });
        if (res.ok) payload = await res.json() as HealthPayload;
    } catch {
        payload = null;
    }

    check('Slack scopes', () => {
        if (!payload) throw new Error('WARN: server not reachable — scope drift cannot be checked');
        const sc = payload.channels?.slackScopes;
        if (!sc || sc.unknown) throw new Error('WARN: not observed yet (no x-oauth-scopes seen since start)');
        const missing = [...(sc.missingRequired ?? []), ...(sc.missingCapabilities ?? [])];
        if (missing.length === 0) return 'granted set matches the shipped manifest';
        const where = sc.reinstallUrl
            ? `reinstall: ${sc.reinstallUrl}`
            : 'add them under OAuth & Permissions, then reinstall the app';
        const level = (sc.missingRequired ?? []).length > 0 ? '' : 'WARN: ';
        throw new Error(`${level}missing: ${missing.join(', ')} — ${where}`);
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
    const s = settings;
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
    // Check enabled-gateway consistency: if discord is in the enabled list, it must also be enabled.
    const enabledChannels = getEnabledChannels(s || {});
    const channelConsistent = !enabledChannels.includes('discord') || !!dc.enabled;
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

function buildSlackStatus() {
    const s = settings;
    const sc = s?.slack || {};
    const botTokenPresent = !!sc.botToken;
    const appTokenPresent = !!sc.appToken;
    // An empty allowlist means "every conversation": the shipped default and a
    // normal way to run. Treating it as a defect is why doctor passed during the
    // 260820 incident — the list had exactly one entry, so it read as configured
    // while every other conversation was silently dropped (#406).
    const { ids: channelIds, scope: channelScope } = slackChannelScope(sc.channelIds);
    let status = 'ok';
    const degradedReasons: string[] = [];
    if (!sc.enabled) { status = 'disabled'; }
    else if (!botTokenPresent) { status = 'missing_bot_token'; degradedReasons.push('bot token missing'); }
    else if (!appTokenPresent) { status = 'missing_app_token'; degradedReasons.push('app-level token missing — outbound only, no inbound events'); }
    else if (channelScope === 'malformed') {
        // Not a missing setting — a present one the gate cannot read, so it
        // denies every channel. Tokens alone used to carry this to status "ok",
        // which is the same silence #406 is about: the bot hears nothing and
        // doctor says it is fine.
        status = 'malformed_channel_ids';
        degradedReasons.push('slack.channelIds is not a list of conversation ids — every channel is denied; set it to [] to allow all conversations');
    }

    const enabledChannels = getEnabledChannels(s || {});
    const channelConsistent = !enabledChannels.includes('slack') || !!sc.enabled;
    if (!channelConsistent) {
        degradedReasons.push('active channel is slack but Slack is not enabled');
    }

    return {
        status,
        enabled: !!sc.enabled,
        botTokenPresent,
        appTokenPresent,
        channelIds,
        channelScope,
        // Deprecated alias, kept one major version so existing --json consumers
        // do not break on a silent field removal. It now answers "is the reach
        // narrowed" as the gate sees it, so a malformed value reads false where
        // the old raw-array count read true. Prefer channelScope (#406).
        channelIdsConfigured: channelIds.length > 0,
        channelConsistent,
        runtimeReady: status === 'ok' && channelConsistent,
        // C/G/D conversations only — mpim:history is not in the manifest, so
        // MPIM lookups surface missing_scope at call time (260806 unit).
        historyLookup: botTokenPresent,
        socketModeNote: 'app-level token (xapp-) is required for inbound events; a bot token alone is outbound-only',
        degradedReasons,
    };
}

// Slack OAuth scope drift (#340). Deliberately NOT inside check(), whose
// callback is `() => string`: returning a promise there would render as
// [object Promise] and a rejection would escape its try/catch. Same async
// shape as runTccDiagnostics above.
await runSlackScopeDiagnostics();

// macOS TCC diagnostics (--tcc, --fix, --prime)
if (process.platform === 'darwin' && (values.tcc || values.fix || values.prime)) {
    await runTccDiagnostics({ fix: !!values.fix, prime: !!values.prime });
}

// Output
// Network
if (!values.json) {
    const netCfg = loadedSettings().network || {};
    const bh = netCfg.bindHost || '127.0.0.1';
    const lb = netCfg.lanBypass === true;
    const tokenEnv = !!process.env["JAW_AUTH_TOKEN"];
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
    const ra = {
        mode: netCfg.remoteAccess?.mode || 'off',
        trustProxies: netCfg.remoteAccess?.trustProxies === true,
        trustForwardedFor: netCfg.remoteAccess?.trustForwardedFor === true,
        requireAuth: netCfg.remoteAccess?.requireAuth !== false,
    };
    console.log(`    remoteAccess.mode : ${ra.mode}`);
    console.log(`    trustProxies      : ${ra.trustProxies}`);
    console.log(`    trustForwardedFor : ${ra.trustForwardedFor}`);
    console.log(`    requireAuth       : ${ra.requireAuth}`);
    if (ra.trustForwardedFor && !ra.trustProxies) {
        console.log('    ⚠️  KR: 프록시를 신뢰하지 않으면 X-Forwarded-For는 쓰면 안 돼.');
        console.log('       EN: Do not enable forwarded client IP parsing without trusting the proxy hop.');
    }
}

if (values.json) {
    const netCfg = loadedSettings().network || {};
    const bh = netCfg.bindHost || '127.0.0.1';
    const lb = netCfg.lanBypass === true;
    const networkIssues: string[] = [];
    const isLoopbackJson = bh === '127.0.0.1' || bh === '::1' || bh === 'localhost';
    if (lb && isLoopbackJson) networkIssues.push('lanBypass enabled but bindHost is loopback');
    if (!isLoopbackJson && bh !== '0.0.0.0') {
        networkIssues.push(`bindHost=${bh} — specific interface, LAN accessibility depends on routing`);
    }
    const snapshot = loadedSettings();
    const homeChannel = getHomeChannel(snapshot);
    const enabledChannels = getEnabledChannels(snapshot);
    const output: Record<string, unknown> = {
        checks: results,
        network: { bindHost: bh, lanBypass: lb, authTokenPersisted: !!process.env["JAW_AUTH_TOKEN"], issues: networkIssues },
        activeChannel: homeChannel,
        enabledChannels,
        homeChannel,
        discord: buildDiscordStatus(),
        slack: buildSlackStatus(),
        platform: resolvePlatformKind(),
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
