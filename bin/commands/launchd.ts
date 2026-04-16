/**
 * cli-jaw launchd — macOS LaunchAgent 관리
 * Usage:
 *   jaw launchd              — plist 확인 → 없으면 생성 → 시작 (원스텝)
 *   jaw launchd --port 3458  — 커스텀 포트로 등록
 *   jaw launchd unset        — plist 제거 + 해제
 *   jaw launchd status       — 현재 상태 확인
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { JAW_HOME } from '../../src/core/config.js';
import { instanceId, getNodePath, getJawPath, buildServicePath } from '../../src/core/instance.js';

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// parseArgs is safe here — launchd is a leaf command (no subcommands to absorb)
const { values: launchdOpts, positionals: launchdPos } = parseArgs({
    args: process.argv.slice(3),
    options: { port: { type: 'string', default: '3457' } },
    strict: false,
    allowPositionals: true,
});
const PORT = launchdOpts.port as string;

// unknown flag guard (strict:false absorbs unknowns silently)
const knownKeys = new Set(['port']);
for (const key of Object.keys(launchdOpts)) {
    if (!knownKeys.has(key)) {
        console.error(`❌ Unknown option: --${key}`);
        console.error('   Usage: jaw launchd [--port PORT] [status|unset]');
        process.exit(1);
    }
}

const INSTANCE = instanceId();
const LABEL = `com.cli-jaw.${INSTANCE}`;
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = join(JAW_HOME, 'logs');
const USER_ID = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID || 0);
const GUI_DOMAIN = `gui/${USER_ID}`;


function generatePlist(): string {
    const nodePath = getNodePath();
    const jawPath = getJawPath();
    const servicePath = buildServicePath(process.env.PATH || '', [join(homedir(), '.local', 'bin')]);
    execSync(`mkdir -p "${LOG_DIR}"`);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEsc(LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEsc(nodePath)}</string>
        <string>${xmlEsc(jawPath)}</string>
        <string>--home</string>
        <string>${xmlEsc(JAW_HOME)}</string>
        <string>serve</string>
        <string>--port</string>
        <string>${xmlEsc(PORT)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>WorkingDirectory</key>
    <string>${xmlEsc(JAW_HOME)}</string>
    <key>StandardOutPath</key>
    <string>${xmlEsc(LOG_DIR)}/jaw-serve.log</string>
    <key>StandardErrorPath</key>
    <string>${xmlEsc(LOG_DIR)}/jaw-serve.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xmlEsc(servicePath)}</string>
        <key>CLI_JAW_HOME</key>
        <string>${xmlEsc(JAW_HOME)}</string>
    </dict>
</dict>
</plist>`;
}

function isLoaded(): boolean {
    try {
        execSync(`launchctl print ${GUI_DOMAIN}/${LABEL}`, { stdio: 'pipe' });
        return true;
    } catch { return false; }
}

const sub = launchdPos[0];

switch (sub) {
    case 'unset': {
        if (!existsSync(PLIST_PATH)) {
            console.log('⚠️  launchd에 등록되어 있지 않습니다');
            break;
        }
        try { execSync(`launchctl bootout ${GUI_DOMAIN}/${LABEL}`, { stdio: 'pipe' }); } catch { /* ok */ }
        unlinkSync(PLIST_PATH);
        console.log('✅ jaw serve 자동 실행 해제 완료');
        break;
    }
    case 'status': {
        if (!existsSync(PLIST_PATH)) {
            console.log('⚠️  jaw serve가 launchd에 등록되어 있지 않습니다');
            console.log('   등록: jaw launchd');
            break;
        }
        try {
            const out = execSync(`launchctl print ${GUI_DOMAIN}/${LABEL}`, { encoding: 'utf8' });
            const pidMatch = out.match(/pid = (\d+)/);
            const pid = pidMatch ? `running (PID ${pidMatch[1]})` : 'loaded';
            console.log(`🦈 jaw serve — ${pid}`);
            console.log(`   instance: ${INSTANCE}`);
            console.log(`   port:     ${PORT}`);
            console.log(`   plist: ${PLIST_PATH}`);
            console.log(`   log:   ${LOG_DIR}/jaw-serve.log`);
            console.log(`   domain: ${GUI_DOMAIN}`);
        } catch {
            console.log('🦈 jaw serve — not loaded');
            console.log(`   plist: ${PLIST_PATH} (exists but not loaded)`);
        }
        break;
    }
    default: {
        // 원스텝: 확인 → 생성 → 시작
        console.log('🦈 jaw launchd setup\n');

        // 1. plist 확인
        if (existsSync(PLIST_PATH)) {
            console.log('📄 plist 발견 — 재생성합니다');
            try { execSync(`launchctl bootout ${GUI_DOMAIN}/${LABEL}`, { stdio: 'pipe' }); } catch { /* ok */ }
        } else {
            console.log('📄 plist 없음 — 새로 생성합니다');
        }

        // 2. plist 생성
        const plist = generatePlist();
        writeFileSync(PLIST_PATH, plist);
        console.log(`✅ plist 저장: ${PLIST_PATH}`);

        // 3. launchd 등록 + 시작
        execSync(`launchctl bootstrap ${GUI_DOMAIN} "${PLIST_PATH}"`);
        console.log('✅ launchd 등록 + 시작 완료\n');

        // 4. 상태 확인
        setTimeout(() => {
            if (isLoaded()) {
                console.log('🦈 jaw serve가 백그라운드에서 실행 중입니다');
                console.log(`   instance: ${INSTANCE}`);
                console.log(`   http://localhost:${PORT}`);
                console.log(`   로그: ${LOG_DIR}/jaw-serve.log`);
                console.log('\n   해제: jaw launchd unset');
            } else {
                console.log('⚠️  시작되지 않았습니다. 로그를 확인하세요:');
                console.log(`   cat ${LOG_DIR}/jaw-serve.err`);
            }
        }, 1000);
        break;
    }
}
