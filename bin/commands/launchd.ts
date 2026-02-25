/**
 * cli-jaw launchd — macOS LaunchAgent 관리
 * Usage:
 *   jaw launchd         — plist 확인 → 없으면 생성 → 시작 (원스텝)
 *   jaw launchd unset   — plist 제거 + 해제
 *   jaw launchd status  — 현재 상태 확인
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LABEL = 'com.cli-jaw.serve';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = join(homedir(), '.cli-jaw', 'logs');

function getNodePath(): string {
    try { return execSync('which node', { encoding: 'utf8' }).trim(); }
    catch { return '/usr/local/bin/node'; }
}

function getJawPath(): string {
    try { return execSync('which jaw', { encoding: 'utf8' }).trim(); }
    catch { return execSync('which cli-jaw', { encoding: 'utf8' }).trim(); }
}

function generatePlist(): string {
    const nodePath = getNodePath();
    const jawPath = getJawPath();
    execSync(`mkdir -p ${LOG_DIR}`);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${jawPath}</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${homedir()}</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/jaw-serve.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/jaw-serve.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env.PATH}</string>
    </dict>
</dict>
</plist>`;
}

function isLoaded(): boolean {
    try {
        const out = execSync(`launchctl list | grep ${LABEL}`, { encoding: 'utf8' }).trim();
        return !!out;
    } catch { return false; }
}

const sub = process.argv[3];

switch (sub) {
    case 'unset': {
        if (!existsSync(PLIST_PATH)) {
            console.log('⚠️  launchd에 등록되어 있지 않습니다');
            break;
        }
        try { execSync(`launchctl unload ${PLIST_PATH}`, { stdio: 'pipe' }); } catch { /* ok */ }
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
            const out = execSync(`launchctl list | grep ${LABEL}`, { encoding: 'utf8' }).trim();
            const parts = out.split('\t');
            const pid = parts[0] === '-' ? 'stopped' : `running (PID ${parts[0]})`;
            console.log(`🦈 jaw serve — ${pid}`);
            console.log(`   plist: ${PLIST_PATH}`);
            console.log(`   log:   ${LOG_DIR}/jaw-serve.log`);
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
            try { execSync(`launchctl unload ${PLIST_PATH}`, { stdio: 'pipe' }); } catch { /* ok */ }
        } else {
            console.log('📄 plist 없음 — 새로 생성합니다');
        }

        // 2. plist 생성
        const plist = generatePlist();
        writeFileSync(PLIST_PATH, plist);
        console.log(`✅ plist 저장: ${PLIST_PATH}`);

        // 3. launchd 등록 + 시작
        execSync(`launchctl load -w ${PLIST_PATH}`);
        console.log('✅ launchd 등록 + 시작 완료\n');

        // 4. 상태 확인
        setTimeout(() => {
            if (isLoaded()) {
                console.log('🦈 jaw serve가 백그라운드에서 실행 중입니다');
                console.log('   http://localhost:3457');
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
