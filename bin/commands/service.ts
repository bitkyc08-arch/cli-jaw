/**
 * cli-jaw service — 크로스 플랫폼 서비스 관리
 * Usage:
 *   jaw service              — OS 감지 → 설치 + 시작 (원스텝)
 *   jaw service --port 3458  — 커스텀 포트로 등록
 *   jaw service status       — 현재 상태 확인
 *   jaw service unset        — 서비스 제거
 *   jaw service logs         — 로그 보기
 */
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { JAW_HOME } from '../../src/core/config.js';
import { instanceId, getNodePath, getJawPath, sanitizeUnitName, buildServicePath } from '../../src/core/instance.js';

// ─── Args ────────────────────────────────────────────
const { values: opts, positionals: pos } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: '3457' },
        backend: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
});

// unknown flag guard
const knownKeys = new Set(['port', 'backend']);
for (const key of Object.keys(opts)) {
    if (!knownKeys.has(key)) {
        console.error(`❌ Unknown option: --${key}`);
        console.error('   Usage: jaw service [--port PORT] [--backend jawapp|launchd|systemd|docker] [status|unset|logs]');
        process.exit(1);
    }
}

// --backend whitelist validation
const VALID_BACKENDS = new Set(['jawapp', 'launchd', 'systemd', 'docker']);
if (opts.backend && !VALID_BACKENDS.has(opts.backend as string)) {
    console.error(`❌ Unknown backend: ${opts.backend}`);
    console.error('   Supported: jawapp, launchd, systemd, docker');
    process.exit(1);
}

const PORT = opts.port as string;

// port validation: must be numeric and in valid range
const portNum = Number(PORT);
if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    console.error(`\u274c Invalid port: ${PORT}`);
    console.error('   Port must be an integer between 1 and 65535');
    process.exit(1);
}

const INSTANCE = instanceId();
const LOG_DIR = join(JAW_HOME, 'logs');

// ─── Backend detection ───────────────────────────────

type Backend = 'jawapp' | 'launchd' | 'systemd' | 'docker';

function detectBackend(): Backend {
    if (process.platform === 'darwin') {
        if (existsSync('/Applications/Jaw.app/Contents/MacOS/jaw-launcher')) {
            return 'jawapp';
        }
        return 'launchd';
    }

    // Docker container detection
    if (existsSync('/.dockerenv')) return 'docker';

    // Linux: verify PID 1 is actually systemd (not just binary installed)
    try {
        const pid1 = readFileSync('/proc/1/comm', 'utf8').trim();
        if (pid1 === 'systemd') return 'systemd';
    } catch { /* /proc may not exist */ }

    // Fallback: check systemctl exists (less reliable but covers more cases)
    try {
        execFileSync('which', ['systemctl'], { stdio: 'pipe' });
        console.warn('⚠️  PID 1이 systemd가 아닐 수 있습니다. --backend systemd로 강제 지정 가능');
        return 'systemd';
    } catch { /* no systemctl */ }

    console.error('❌ 지원되지 않는 환경입니다.');
    console.error('   지원: macOS (launchd), Linux (systemd), Docker');
    console.error('   수동 설정은 jaw serve를 tmux/screen에서 실행하세요.');
    process.exit(1);
}

const backend: Backend = (opts.backend as Backend) || detectBackend();

// ─── Jaw.app helper ─────────────────────────────────

const JAW_APP_LAUNCHER = '/Applications/Jaw.app/Contents/MacOS/jaw-launcher';

function isJawAppRunning(): boolean {
    try {
        execFileSync('pgrep', ['-f', 'Jaw.app/Contents/MacOS/jaw-launcher'], { stdio: 'pipe' });
        return true;
    } catch { return false; }
}

function getJawAppPid(): string | null {
    try {
        return execFileSync('pgrep', ['-f', 'Jaw.app/Contents/MacOS/jaw-launcher'], {
            encoding: 'utf8', stdio: 'pipe',
        }).trim().split('\n')[0] || null;
    } catch { return null; }
}

function restartJawApp(): void {
    const pid = getJawAppPid();
    if (pid) {
        try { execFileSync('kill', [pid], { stdio: 'pipe' }); } catch { /* ok */ }
        try { execFileSync('sleep', ['1']); } catch { /* ok */ }
    }
    try {
        execFileSync('open', ['-a', 'Jaw'], { stdio: 'pipe' });
    } catch (e: any) {
        console.error(`❌ Jaw.app 실행 실패: ${e?.message || 'unknown'}`);
        console.error('   설치: npm install -g cli-jaw');
        process.exit(1);
    }
}

function migrateLaunchdIfNeeded(): void {
    const label = `com.cli-jaw.${INSTANCE}`;
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (!existsSync(plistPath)) return;

    const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID || 0);
    const domain = `gui/${uid}`;
    console.log('  🔄 launchd → Jaw.app 마이그레이션...');
    try { execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'pipe' }); } catch { /* ok */ }
    try { unlinkSync(plistPath); } catch { /* ok */ }
    console.log('  ✅ launchd plist 제거 완료');
}

// ─── macOS: Jaw.app backend ─────────────────────────

if (backend === 'jawapp') {
    const { addInstance, removeInstance, listInstances } = await import('../../src/core/jawapp-instances.js');
    const subcommand = pos[0];

    switch (subcommand) {
        case 'status': {
            const running = isJawAppRunning();
            const instances = listInstances();
            const icon = running ? '🟢' : '⚪';
            console.log(`🦈 jaw serve (Jaw.app) — ${icon} ${running ? 'running' : 'stopped'}`);
            console.log(`   backend:   jawapp (TCC inherited)`);
            console.log(`   instances: ${instances.length}`);
            for (const inst of instances) {
                console.log(`     - ${inst.home} :${inst.port}`);
            }
            if (running) {
                const pid = getJawAppPid();
                if (pid) console.log(`   PID:       ${pid}`);
            }
            if (!running && instances.length > 0) {
                console.log('\n   시작: jaw service');
            }
            console.log('\n   해제: jaw service unset');
            break;
        }
        case 'unset': {
            removeInstance(JAW_HOME, portNum);
            console.log(`✅ 인스턴스 제거: ${JAW_HOME} :${portNum}`);
            const remaining = listInstances();
            if (remaining.length === 0) {
                const pid = getJawAppPid();
                if (pid) {
                    try { execFileSync('kill', [pid], { stdio: 'pipe' }); } catch { /* ok */ }
                }
                console.log('✅ Jaw.app 중지 (인스턴스 없음)');
            } else {
                // SIGHUP → serve-manager re-reads registry
                const pid = getJawAppPid();
                if (pid) {
                    try { execFileSync('kill', ['-HUP', pid], { stdio: 'pipe' }); } catch { /* ok */ }
                    console.log('🔄 Jaw.app에 변경 알림 (SIGHUP)');
                }
            }
            break;
        }
        case 'logs': {
            const logDir = join(JAW_HOME, 'logs');
            console.log(`📋 Jaw.app instance logs:\n`);
            console.log(`   stdout: ${logDir}/jaw-serve.log`);
            console.log(`   stderr: ${logDir}/jaw-serve.err\n`);
            console.log(`   tail -f ${logDir}/jaw-serve.log`);
            break;
        }
        default: {
            console.log('🦈 jaw service setup (Jaw.app)\n');

            if (!existsSync(JAW_APP_LAUNCHER)) {
                console.error('❌ Jaw.app이 설치되어 있지 않습니다.');
                console.error('   설치: npm install -g cli-jaw');
                console.error('   또는: --backend launchd 로 대체 가능');
                process.exit(1);
            }

            migrateLaunchdIfNeeded();

            addInstance(JAW_HOME, portNum);
            console.log(`✅ 인스턴스 등록: ${JAW_HOME} :${portNum}`);

            restartJawApp();
            console.log('✅ Jaw.app 실행\n');

            setTimeout(() => {
                if (isJawAppRunning()) {
                    console.log('🦈 jaw serve — Jaw.app에서 실행 중 (TCC 권한 상속)');
                    console.log(`   http://localhost:${PORT}`);
                    console.log(`   로그: ${join(JAW_HOME, 'logs')}/jaw-serve.log`);
                    console.log('\n   상태: jaw service status');
                    console.log('   해제: jaw service unset');
                } else {
                    console.log('⚠️  Jaw.app이 시작되지 않았습니다.');
                    console.log('   확인: open -a Jaw && tail -f ~/.cli-jaw/logs/jaw-serve.err');
                }
            }, 2000);
            break;
        }
    }
    process.exit(0);
}

// ─── macOS: delegate to launchd command (legacy) ────
if (backend === 'launchd') {
    // launchd.ts supports: status, unset, default (install)
    // service.ts additionally supports: logs
    // Map unsupported subcommands for launchd
    const subcommand = pos[0];
    if (subcommand === 'logs') {
        // launchd doesn't have 'logs' → show log file path directly
        const logDir = join(JAW_HOME, 'logs');
        console.log(`📋 macOS launchd logs:\n`);
        console.log(`   stdout: ${logDir}/jaw-serve.log`);
        console.log(`   stderr: ${logDir}/jaw-serve.err\n`);
        console.log(`   tail -f ${logDir}/jaw-serve.log`);
        process.exit(0);
    }
    // Rebuild argv from parsed values — eliminates all --backend variants
    // Only pass --port on install (default). status/unset read from existing plist.
    const isInstall = !subcommand || (subcommand !== 'status' && subcommand !== 'unset');
    const portArgs = isInstall && PORT !== '3457' ? ['--port', PORT] : [];
    process.argv = [
        process.argv[0]!, process.argv[1]!,
        'launchd',
        ...(subcommand ? [subcommand] : []),
        ...portArgs,
    ];
    await import('./launchd.js');
    process.exit(0);
}

// ─── Docker: info only ───────────────────────────────
if (backend === 'docker') {
    console.log('🐳 Docker 컨테이너 내부에서 실행 중입니다.\n');
    console.log('   컨테이너 자체가 restart policy로 관리됩니다.');
    console.log('   docker-compose.yml의 restart: unless-stopped 설정을 확인하세요.\n');
    console.log('   상태 확인: docker ps | grep cli-jaw');
    console.log('   로그 확인: docker logs -f cli-jaw');
    process.exit(0);
}

// ═══════════════════════════════════════════════════════
//  systemd backend
// ═══════════════════════════════════════════════════════

const SAFE_INSTANCE = sanitizeUnitName(INSTANCE);
const UNIT_NAME = `jaw-${SAFE_INSTANCE}`;
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}.service`;

/** Create secure temp file for unit generation. */
function makeTmpUnit(): string {
    try {
        return execFileSync('mktemp', ['/tmp/jaw-unit-XXXXXX.service'], { encoding: 'utf8' }).trim();
    } catch {
        // fallback if mktemp unavailable
        const fallback = `/tmp/jaw-unit-${Date.now()}-${process.pid}.service`;
        return fallback;
    }
}

/** Run a sudo command with visible output (password prompt visible). */
function sudo(args: string[]): void {
    execFileSync('sudo', args, { stdio: 'inherit' });
}

function generateUnit(): string {
    const nodePath = getNodePath();
    const jawPath = getJawPath();
    const servicePath = buildServicePath(process.env.PATH || '', [dirname(nodePath), dirname(jawPath)]);
    let user: string;
    try { user = execFileSync('whoami', { encoding: 'utf8' }).trim(); }
    catch { user = 'nobody'; }
    mkdirSync(LOG_DIR, { recursive: true });

    // systemd quoting: paths with spaces must be quoted
    const q = (s: string) => s.includes(' ') ? `"${s}"` : s;

    return `[Unit]
Description=CLI-JAW Server (${SAFE_INSTANCE})
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${q(JAW_HOME)}
ExecStart=${q(nodePath)} ${q(jawPath)} --home ${q(JAW_HOME)} serve --port ${PORT} --no-open
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment="PATH=${servicePath}"
Environment=CLI_JAW_HOME=${q(JAW_HOME)}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${UNIT_NAME}

[Install]
WantedBy=multi-user.target`;
}

function isActive(): string {
    try {
        return execFileSync('systemctl', ['is-active', UNIT_NAME], { encoding: 'utf8' }).trim();
    } catch { return 'inactive'; }
}

const sub = pos[0];

switch (sub) {
    case 'unset': {
        if (!existsSync(UNIT_PATH)) {
            console.log('⚠️  jaw serve가 systemd에 등록되어 있지 않습니다');
            break;
        }
        try { sudo(['systemctl', 'stop', UNIT_NAME]); } catch { /* ok if already stopped */ }
        try { sudo(['systemctl', 'disable', UNIT_NAME]); } catch { /* ok */ }
        sudo(['rm', '-f', UNIT_PATH]);
        sudo(['systemctl', 'daemon-reload']);
        console.log('✅ jaw serve 자동 실행 해제 완료');
        break;
    }

    case 'status': {
        if (!existsSync(UNIT_PATH)) {
            console.log('\u26a0\ufe0f  jaw serve\uac00 systemd\uc5d0 \ub4f1\ub85d\ub418\uc5b4 \uc788\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4');
            console.log('   \ub4f1\ub85d: jaw service');
            break;
        }
        // Read actual port from unit file if possible
        let displayPort = PORT;
        try {
            const unitContent = readFileSync(UNIT_PATH, 'utf8');
            const portMatch = unitContent.match(/--port\s+(\d+)/);
            if (portMatch) displayPort = portMatch[1]!;
        } catch { /* use CLI port as fallback */ }
        const state = isActive();
        const icon = state === 'active' ? '\ud83d\udfe2' : state === 'failed' ? '\ud83d\udd34' : '\u26aa';
        console.log(`\ud83e\udd88 jaw serve \u2014 ${icon} ${state}`);
        console.log(`   instance: ${INSTANCE}`);
        console.log(`   unit:     ${UNIT_NAME}`);
        console.log(`   port:     ${displayPort}`);
        console.log(`   unit file: ${UNIT_PATH}`);
        console.log(`\n   \ub85c\uadf8: jaw service logs`);
        console.log(`   \uc911\uc9c0: jaw service unset`);
        break;
    }

    case 'logs': {
        console.log(`📋 journalctl -u ${UNIT_NAME} -f\n`);
        const child = nodeSpawn('journalctl', ['-u', UNIT_NAME, '-f', '--no-pager', '-n', '50'], {
            stdio: 'inherit',
        });
        // Clean exit on Ctrl+C
        const cleanup = () => { child.kill('SIGINT'); process.exit(0); };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        child.on('exit', (code) => process.exit(code ?? 0));
        break;
    }

    default: {
        // 원스텝: 유닛 생성 → daemon-reload → enable --now
        console.log('🦈 jaw service setup (systemd)\n');

        if (existsSync(UNIT_PATH)) {
            console.log('📄 기존 유닛 발견 — 재생성합니다');
            try { sudo(['systemctl', 'stop', UNIT_NAME]); } catch { /* ok */ }
        } else {
            console.log('📄 유닛 없음 — 새로 생성합니다');
        }

        // 1. 유닛 파일 생성 (mktemp → sudo cp)
        const unit = generateUnit();
        const tmpUnit = makeTmpUnit();
        writeFileSync(tmpUnit, unit);
        sudo(['cp', tmpUnit, UNIT_PATH]);
        try { writeFileSync(tmpUnit, ''); } catch { /* cleanup */ }
        console.log(`✅ 유닛 저장: ${UNIT_PATH}`);

        // 2. 등록 + 시작
        sudo(['systemctl', 'daemon-reload']);
        sudo(['systemctl', 'enable', '--now', UNIT_NAME]);
        console.log('✅ systemd 등록 + 시작 완료\n');

        // 3. 상태 확인
        setTimeout(() => {
            const state = isActive();
            if (state === 'active') {
                console.log('🦈 jaw serve가 백그라운드에서 실행 중입니다');
                console.log(`   instance: ${INSTANCE}`);
                console.log(`   http://localhost:${PORT}`);
                console.log(`   로그: jaw service logs`);
                console.log('\n   해제: jaw service unset');
            } else {
                console.log('⚠️  시작되지 않았습니다. 상태를 확인하세요:');
                console.log(`   systemctl status ${UNIT_NAME}`);
                console.log(`   journalctl -u ${UNIT_NAME} --no-pager -n 20`);
            }
        }, 2000);
        break;
    }
}
