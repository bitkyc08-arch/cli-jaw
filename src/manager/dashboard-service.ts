import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getNodePath, getJawPath, buildServicePath } from '../core/instance.js';
import { detectBackend } from './platform-service.js';

const LABEL_LAUNCHD = 'com.cli-jaw.dashboard';
const LABEL_SYSTEMD = 'jaw-dashboard';

function plistPath(): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${LABEL_LAUNCHD}.plist`);
}

function unitPath(): string {
    return join(homedir(), '.config', 'systemd', 'user', `${LABEL_SYSTEMD}.service`);
}

function generateDashboardPlist(port: number, from: number, count: number): string {
    const nodePath = getNodePath();
    const jawPath = getJawPath();
    const jawHome = join(homedir(), '.cli-jaw');
    const logDir = join(jawHome, 'logs');
    const servicePath = buildServicePath(process.env["PATH"] || '', [join(homedir(), '.local', 'bin')]);
    mkdirSync(logDir, { recursive: true });

    const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${x(LABEL_LAUNCHD)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${x(nodePath)}</string>
        <string>${x(jawPath)}</string>
        <string>dashboard</string>
        <string>serve</string>
        <string>--port</string>
        <string>${port}</string>
        <string>--from</string>
        <string>${from}</string>
        <string>--count</string>
        <string>${count}</string>
        <string>--no-open</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>WorkingDirectory</key>
    <string>${x(jawHome)}</string>
    <key>StandardOutPath</key>
    <string>${x(logDir)}/dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>${x(logDir)}/dashboard.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${x(servicePath)}</string>
        <key>CLI_JAW_HOME</key>
        <string>${x(jawHome)}</string>
        <key>CLI_JAW_RUNTIME</key>
        <string>launchd</string>
    </dict>
</dict>
</plist>`;
}

function generateDashboardUnit(port: number, from: number, count: number): string {
    const nodePath = getNodePath();
    const jawPath = getJawPath();
    const jawHome = join(homedir(), '.cli-jaw');
    const servicePath = buildServicePath(process.env["PATH"] || '', [join(homedir(), '.local', 'bin')]);
    const logDir = join(jawHome, 'logs');
    mkdirSync(logDir, { recursive: true });

    const q = (s: string) => s.includes(' ') ? `"${s}"` : s;
    return `[Unit]
Description=CLI-JAW Dashboard Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${q(jawHome)}
ExecStart=${q(nodePath)} ${q(jawPath)} dashboard serve --port ${port} --from ${from} --count ${count} --no-open
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment="PATH=${servicePath}"
Environment=CLI_JAW_HOME=${q(jawHome)}
Environment=CLI_JAW_RUNTIME=systemd
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${LABEL_SYSTEMD}

[Install]
WantedBy=default.target`;
}

export async function permDashboard(port: number, from: number, count: number): Promise<void> {
    const backend = detectBackend();
    if (backend === 'none') {
        console.error('❌ No supported service backend (need macOS launchd or Linux systemd)');
        process.exitCode = 1;
        return;
    }

    if (backend === 'launchd') {
        const { execFileSync } = await import('node:child_process');
        const path = plistPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, generateDashboardPlist(port, from, count));
        const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
        const isRegistered = (): boolean => {
            try { execFileSync('/bin/launchctl', ['print', `gui/${uid}/${LABEL_LAUNCHD}`], { stdio: 'pipe' }); return true; } catch { return false; }
        };
        try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL_LAUNCHD}`], { stdio: 'pipe' }); } catch {} // best-effort: bootout may fail when service not yet registered
        // launchd tears down asynchronously after bootout; bootstrapping while the
        // old registration is still draining fails with "Bootstrap failed: 5".
        for (let i = 0; i < 20 && isRegistered(); i++) {
            try { execFileSync('/bin/sleep', ['0.1'], { stdio: 'pipe' }); } catch {}
        }
        let bootstrapped = false;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3 && !bootstrapped; attempt++) {
            try {
                execFileSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, path], { stdio: 'pipe' });
                bootstrapped = true;
            } catch (err) {
                lastError = err;
                if (isRegistered()) { bootstrapped = true; break; } // already loaded and healthy enough
                try { execFileSync('/bin/sleep', ['0.3'], { stdio: 'pipe' }); } catch {}
            }
        }
        if (!bootstrapped) throw lastError;
        console.log(`✅ Dashboard registered as ${LABEL_LAUNCHD}`);
        console.log(`   Plist: ${path}`);
    }

    if (backend === 'systemd') {
        const { execFileSync } = await import('node:child_process');
        const path = unitPath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, generateDashboardUnit(port, from, count));
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
        execFileSync('systemctl', ['--user', 'enable', '--now', LABEL_SYSTEMD], { stdio: 'pipe' });
        console.log(`✅ Dashboard registered as ${LABEL_SYSTEMD}`);
        console.log(`   Unit: ${path}`);
    }
}

export async function unpermDashboard(jsonOut = false): Promise<void> {
    const backend = detectBackend();
    if (backend === 'launchd') {
        const { execFileSync } = await import('node:child_process');
        const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
        try { execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL_LAUNCHD}`], { stdio: 'pipe' }); } catch {} // best-effort: bootout may fail when service not yet registered
        const path = plistPath();
        if (existsSync(path)) unlinkSync(path);
        if (jsonOut) console.log(JSON.stringify({ ok: true, action: 'unset', backend }));
        else console.log(`✅ Dashboard service removed (${LABEL_LAUNCHD})`);
        return;
    }
    if (backend === 'systemd') {
        const { execFileSync } = await import('node:child_process');
        try { execFileSync('systemctl', ['--user', 'disable', '--now', LABEL_SYSTEMD], { stdio: 'pipe' }); } catch {} // best-effort: disable may fail when unit not registered
        const path = unitPath();
        if (existsSync(path)) unlinkSync(path);
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
        if (jsonOut) console.log(JSON.stringify({ ok: true, action: 'unset', backend }));
        else console.log(`✅ Dashboard service removed (${LABEL_SYSTEMD})`);
        return;
    }
    console.error('❌ No supported service backend');
    process.exitCode = 1;
}

export async function dashboardServiceStatus(jsonOut = false): Promise<void> {
    const backend = detectBackend();
    if (backend === 'launchd') {
        const registered = existsSync(plistPath());
        let loaded = false;
        let pid: number | null = null;
        if (registered) {
            const { execFileSync } = await import('node:child_process');
            const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
            try {
                const out = execFileSync('/bin/launchctl', ['print', `gui/${uid}/${LABEL_LAUNCHD}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
                loaded = true;
                const m = out.match(/pid\s*=\s*(\d+)/);
                if (m) pid = Number(m[1]);
            } catch {} // best-effort: launchctl print fails when not loaded
        }
        if (jsonOut) {
            console.log(JSON.stringify({ backend, label: LABEL_LAUNCHD, registered, loaded, pid }));
        } else {
            console.log(`  Backend: launchd`);
            console.log(`  Label: ${LABEL_LAUNCHD}`);
            console.log(`  Registered: ${registered ? 'yes' : 'no'}`);
            console.log(`  Running: ${loaded ? `yes (pid ${pid})` : 'no'}`);
        }
        return;
    }
    if (backend === 'systemd') {
        const registered = existsSync(unitPath());
        let active = false;
        let pid: number | null = null;
        if (registered) {
            const { execFileSync } = await import('node:child_process');
            try {
                const out = execFileSync('systemctl', ['--user', 'show', LABEL_SYSTEMD, '--property=ActiveState,MainPID'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
                active = out.includes('ActiveState=active');
                const m = out.match(/MainPID=(\d+)/);
                if (m && Number(m[1]) > 0) pid = Number(m[1]);
            } catch {} // best-effort: systemctl show fails when unit missing
        }
        if (jsonOut) {
            console.log(JSON.stringify({ backend, label: LABEL_SYSTEMD, registered, active, pid }));
        } else {
            console.log(`  Backend: systemd`);
            console.log(`  Unit: ${LABEL_SYSTEMD}`);
            console.log(`  Registered: ${registered ? 'yes' : 'no'}`);
            console.log(`  Running: ${active ? `yes (pid ${pid})` : 'no'}`);
        }
        return;
    }
    if (jsonOut) console.log(JSON.stringify({ backend: 'none', registered: false }));
    else console.error('  No supported service backend');
}
