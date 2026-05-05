import { execFile, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { getNodePath, getJawPath, buildServicePath } from '../core/instance.js';
import { MANAGED_INSTANCE_PORT_FROM, MANAGED_INSTANCE_PORT_TO } from './constants.js';
import type { DashboardServiceState, DashboardLifecycleResult } from './types.js';

const SYSTEMCTL = 'systemctl';
const OP_TIMEOUT_MS = 5000;

export function isSystemdSupported(): boolean {
    if (process.platform !== 'linux') return false;
    try {
        execFileSync('which', ['systemctl'], { stdio: 'pipe' });
        return true;
    } catch { return false; }
}

function instanceIdForHome(home: string): string {
    const base = basename(home);
    if (base === '.cli-jaw') return 'default';
    const hash = createHash('md5').update(home).digest('hex').slice(0, 8);
    return `${base.replace(/^\./, '')}-${hash}`;
}

function sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9:._-]/g, '-');
}

export function computeUnitName(port: number, home: string): string {
    const id = sanitize(instanceIdForHome(home));
    return `jaw-${id}`;
}

function userUnitDir(): string {
    return join(homedir(), '.config', 'systemd', 'user');
}

export function computeUnitPath(unitName: string): string {
    return join(userUnitDir(), `${unitName}.service`);
}

function execSystemctl(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const child = execFile(SYSTEMCTL, ['--user', ...args], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
            const code = err && 'code' in err ? (err as NodeJS.ErrnoException).code ?? 1 : err ? 1 : 0;
            resolve({ stdout: stdout || '', stderr: stderr || '', code: typeof code === 'number' ? code : 1 });
        });
        child.unref?.();
    });
}

function generateUnit(port: number, home: string): string {
    const nodePath = getNodePath();
    const jawPath = getJawPath();
    const servicePath = buildServicePath(process.env.PATH || '', [dirname(nodePath), dirname(jawPath)]);
    const logDir = join(home, 'logs');
    mkdirSync(logDir, { recursive: true });

    const q = (s: string) => s.includes(' ') ? `"${s}"` : s;
    const unitName = computeUnitName(port, home);

    return `[Unit]
Description=CLI-JAW Server (${unitName})
After=network.target

[Service]
Type=simple
WorkingDirectory=${q(home)}
ExecStart=${q(nodePath)} ${q(jawPath)} --home ${q(home)} serve --port ${port} --no-open
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment="PATH=${servicePath}"
Environment=CLI_JAW_HOME=${q(home)}
Environment=CLI_JAW_RUNTIME=systemd
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${unitName}

[Install]
WantedBy=default.target`;
}

export async function detectSystemdState(port: number, home: string): Promise<DashboardServiceState> {
    const unitName = computeUnitName(port, home);
    const unitPath = computeUnitPath(unitName);
    const registered = existsSync(unitPath);

    if (!registered) {
        return { registered: false, loaded: false, pid: null, label: unitName, unitPath, backend: 'systemd' };
    }

    const { stdout, code } = await execSystemctl(['show', unitName, '--property=ActiveState,MainPID'], OP_TIMEOUT_MS);
    if (code !== 0) {
        return { registered: true, loaded: false, pid: null, label: unitName, unitPath, backend: 'systemd' };
    }

    const activeMatch = stdout.match(/ActiveState=(\w+)/);
    const pidMatch = stdout.match(/MainPID=(\d+)/);
    const loaded = activeMatch?.[1] === 'active';
    const pid = pidMatch ? Number(pidMatch[1]) : null;
    return { registered: true, loaded, pid: pid && pid > 0 ? pid : null, label: unitName, unitPath, backend: 'systemd' };
}

export async function detectAllSystemdStates(
    portRange: { from: number; to: number },
    homeRoot = homedir(),
): Promise<Map<number, DashboardServiceState>> {
    const results = new Map<number, DashboardServiceState>();
    if (!isSystemdSupported()) return results;

    const promises: Promise<void>[] = [];
    for (let port = portRange.from; port <= portRange.to; port++) {
        const home = port === MANAGED_INSTANCE_PORT_FROM
            ? join(homeRoot, '.cli-jaw')
            : join(homeRoot, `.cli-jaw-${port}`);
        const unitPath = computeUnitPath(computeUnitName(port, home));
        if (!existsSync(unitPath)) continue;
        const p = port;
        promises.push(
            detectSystemdState(p, home).then((state) => { results.set(p, state); }),
        );
    }
    await Promise.all(promises);
    return results;
}

function validatePort(port: number): boolean {
    return Number.isInteger(port) && port >= MANAGED_INSTANCE_PORT_FROM && port <= MANAGED_INSTANCE_PORT_TO;
}

function validateUnitName(name: string): boolean {
    return name.startsWith('jaw-');
}

export async function permInstance(port: number, home: string): Promise<DashboardLifecycleResult> {
    if (!isSystemdSupported()) {
        return { ok: false, action: 'perm', port, status: 'rejected', message: 'systemd not available', home, pid: null, command: [] };
    }
    if (!validatePort(port)) {
        return { ok: false, action: 'perm', port, status: 'rejected', message: 'port out of managed range', home, pid: null, command: [] };
    }

    const unitName = computeUnitName(port, home);
    if (!validateUnitName(unitName)) {
        return { ok: false, action: 'perm', port, status: 'rejected', message: 'invalid unit name', home, pid: null, command: [] };
    }

    const unitPath = computeUnitPath(unitName);
    mkdirSync(userUnitDir(), { recursive: true });

    const unit = generateUnit(port, home);
    writeFileSync(unitPath, unit);

    await execSystemctl(['daemon-reload'], OP_TIMEOUT_MS);

    const { stderr, code } = await execSystemctl(['enable', '--now', unitName], OP_TIMEOUT_MS);
    if (code !== 0) {
        return {
            ok: false, action: 'perm', port, status: 'error',
            message: `enable failed: ${stderr.trim()}`,
            home, pid: null, command: ['systemctl', '--user', 'enable', '--now', unitName],
        };
    }

    const state = await detectSystemdState(port, home);
    return {
        ok: true, action: 'perm', port, status: 'permed',
        message: `registered as ${unitName}`,
        home, pid: state.pid, command: ['systemctl', '--user', 'enable', '--now', unitName],
        expectedStateAfter: 'online',
    };
}

export async function unpermInstance(port: number, home: string): Promise<DashboardLifecycleResult> {
    if (!isSystemdSupported()) {
        return { ok: false, action: 'unperm', port, status: 'rejected', message: 'systemd not available', home, pid: null, command: [] };
    }

    const unitName = computeUnitName(port, home);
    if (!validateUnitName(unitName)) {
        return { ok: false, action: 'unperm', port, status: 'rejected', message: 'invalid unit name', home, pid: null, command: [] };
    }

    const unitPath = computeUnitPath(unitName);
    if (!existsSync(unitPath)) {
        return { ok: false, action: 'unperm', port, status: 'rejected', message: 'no unit registered', home, pid: null, command: [] };
    }

    await execSystemctl(['disable', '--now', unitName], OP_TIMEOUT_MS);
    try { unlinkSync(unitPath); } catch { /* already gone */ }
    await execSystemctl(['daemon-reload'], OP_TIMEOUT_MS);

    return {
        ok: true, action: 'unperm', port, status: 'unpermed',
        message: `removed ${unitName}`,
        home, pid: null, command: ['systemctl', '--user', 'disable', '--now', unitName],
        expectedStateAfter: 'offline',
    };
}

export async function stopSystemdInstance(unitName: string): Promise<DashboardLifecycleResult> {
    if (!validateUnitName(unitName)) {
        return { ok: false, action: 'stop', port: 0, status: 'rejected', message: 'invalid unit name', home: null, pid: null, command: [] };
    }
    const { code, stderr } = await execSystemctl(['stop', unitName], OP_TIMEOUT_MS);
    if (code !== 0) {
        return { ok: false, action: 'stop', port: 0, status: 'error', message: `stop failed: ${stderr.trim()}`, home: null, pid: null, command: ['systemctl', '--user', 'stop'] };
    }
    return { ok: true, action: 'stop', port: 0, status: 'stopped', message: 'systemd service stopped (unit kept)', home: null, pid: null, command: ['systemctl', '--user', 'stop'] };
}

export async function startSystemdInstance(unitName: string): Promise<DashboardLifecycleResult> {
    if (!validateUnitName(unitName)) {
        return { ok: false, action: 'start', port: 0, status: 'rejected', message: 'invalid unit name', home: null, pid: null, command: [] };
    }
    const { code, stderr } = await execSystemctl(['start', unitName], OP_TIMEOUT_MS);
    if (code !== 0) {
        return { ok: false, action: 'start', port: 0, status: 'error', message: `start failed: ${stderr.trim()}`, home: null, pid: null, command: ['systemctl', '--user', 'start'] };
    }
    return { ok: true, action: 'start', port: 0, status: 'started', message: 'systemd service started', home: null, pid: null, command: ['systemctl', '--user', 'start'] };
}

export async function restartSystemdInstance(unitName: string): Promise<DashboardLifecycleResult> {
    if (!validateUnitName(unitName)) {
        return { ok: false, action: 'restart', port: 0, status: 'rejected', message: 'invalid unit name', home: null, pid: null, command: [] };
    }
    const { code, stderr } = await execSystemctl(['restart', unitName], OP_TIMEOUT_MS);
    if (code !== 0) {
        return { ok: false, action: 'restart', port: 0, status: 'error', message: `restart failed: ${stderr.trim()}`, home: null, pid: null, command: ['systemctl', '--user', 'restart'] };
    }
    return { ok: true, action: 'restart', port: 0, status: 'restarted', message: 'systemd service restarted', home: null, pid: null, command: ['systemctl', '--user', 'restart'] };
}
