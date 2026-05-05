import { execFile } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { generateLaunchdPlist } from '../core/launchd-plist.js';
import { getNodePath, getJawPath, buildServicePath } from '../core/instance.js';
import { MANAGED_INSTANCE_PORT_FROM, MANAGED_INSTANCE_PORT_TO } from './constants.js';
import type { DashboardServiceState, DashboardLifecycleResult } from './types.js';

const LAUNCHCTL = '/bin/launchctl';
const PRINT_TIMEOUT_MS = 2000;
const OP_TIMEOUT_MS = 5000;

function uid(): number {
    return typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID || 501);
}

function guiDomain(): string {
    return `gui/${uid()}`;
}

export function isLaunchdSupported(): boolean {
    return process.platform === 'darwin';
}

export function instanceIdForHome(home: string): string {
    const base = basename(home);
    if (base === '.cli-jaw') return 'default';
    const hash = createHash('md5').update(home).digest('hex').slice(0, 8);
    return `${base.replace(/^\./, '')}-${hash}`;
}

export function computeLaunchdLabel(port: number, home: string): string {
    const id = instanceIdForHome(home);
    return `com.cli-jaw.${id}`;
}

export function computePlistPath(label: string): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function execLaunchctl(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        const child = execFile(LAUNCHCTL, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
            const code = err && 'code' in err ? (err as NodeJS.ErrnoException).code ?? 1 : err ? 1 : 0;
            resolve({ stdout: stdout || '', stderr: stderr || '', code: typeof code === 'number' ? code : 1 });
        });
        child.unref?.();
    });
}

export async function detectLaunchdState(port: number, home: string): Promise<DashboardServiceState> {
    const label = computeLaunchdLabel(port, home);
    const plistPath = computePlistPath(label);
    const registered = existsSync(plistPath);

    if (!registered) {
        return { registered: false, loaded: false, pid: null, label, unitPath: plistPath, backend: 'launchd' };
    }

    const { stdout, code } = await execLaunchctl(['print', `${guiDomain()}/${label}`], PRINT_TIMEOUT_MS);
    if (code !== 0) {
        return { registered: true, loaded: false, pid: null, label, unitPath: plistPath, backend: 'launchd' };
    }

    const pidMatch = stdout.match(/pid\s*=\s*(\d+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : null;
    return { registered: true, loaded: true, pid, label, unitPath: plistPath, backend: 'launchd' };
}

export async function detectAllLaunchdStates(
    portRange: { from: number; to: number },
    homeRoot = homedir(),
): Promise<Map<number, DashboardServiceState>> {
    const results = new Map<number, DashboardServiceState>();
    if (!isLaunchdSupported()) return results;

    const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
    if (!existsSync(agentsDir)) return results;

    const promises: Promise<void>[] = [];
    for (let port = portRange.from; port <= portRange.to; port++) {
        const home = port === MANAGED_INSTANCE_PORT_FROM
            ? join(homeRoot, '.cli-jaw')
            : join(homeRoot, `.cli-jaw-${port}`);
        const label = computeLaunchdLabel(port, home);
        const plistPath = computePlistPath(label);
        if (!existsSync(plistPath)) continue;
        const p = port;
        promises.push(
            detectLaunchdState(p, home).then((state) => { results.set(p, state); }),
        );
    }
    await Promise.all(promises);
    return results;
}

function validatePort(port: number): boolean {
    return Number.isInteger(port) && port >= MANAGED_INSTANCE_PORT_FROM && port <= MANAGED_INSTANCE_PORT_TO;
}

function validateLabel(label: string): boolean {
    return label.startsWith('com.cli-jaw.');
}

export async function permInstance(port: number, home: string): Promise<DashboardLifecycleResult> {
    if (!isLaunchdSupported()) {
        return { ok: false, action: 'perm', port, status: 'rejected', message: 'macOS only', home, pid: null, command: [] };
    }
    if (!validatePort(port)) {
        return { ok: false, action: 'perm', port, status: 'rejected', message: 'port out of managed range', home, pid: null, command: [] };
    }

    const label = computeLaunchdLabel(port, home);
    if (!validateLabel(label)) {
        return { ok: false, action: 'perm', port, status: 'rejected', message: 'invalid label', home, pid: null, command: [] };
    }

    const plistPath = computePlistPath(label);
    const logDir = join(home, 'logs');
    await mkdir(logDir, { recursive: true });

    const nodePath = getNodePath();
    const jawPath = getJawPath();
    const servicePath = buildServicePath(process.env.PATH || '', [join(homedir(), '.local', 'bin')]);

    const plist = generateLaunchdPlist({
        label,
        port: String(port),
        nodePath,
        jawPath,
        jawHome: home,
        logDir,
        servicePath,
    });
    writeFileSync(plistPath, plist);

    // bootout first if already loaded (regenerate scenario)
    await execLaunchctl(['bootout', `${guiDomain()}/${label}`], OP_TIMEOUT_MS);

    const { stderr, code } = await execLaunchctl(
        ['bootstrap', guiDomain(), plistPath],
        OP_TIMEOUT_MS,
    );

    if (code !== 0) {
        return {
            ok: false, action: 'perm', port, status: 'error',
            message: `bootstrap failed: ${stderr.trim()}`,
            home, pid: null, command: ['launchctl', 'bootstrap', guiDomain(), plistPath],
        };
    }

    const state = await detectLaunchdState(port, home);
    return {
        ok: true, action: 'perm', port, status: 'permed',
        message: `registered as ${label}`,
        home, pid: state.pid, command: ['launchctl', 'bootstrap', guiDomain(), plistPath],
        expectedStateAfter: 'online',
    };
}

export async function unpermInstance(port: number, home: string): Promise<DashboardLifecycleResult> {
    if (!isLaunchdSupported()) {
        return { ok: false, action: 'unperm', port, status: 'rejected', message: 'macOS only', home, pid: null, command: [] };
    }

    const label = computeLaunchdLabel(port, home);
    if (!validateLabel(label)) {
        return { ok: false, action: 'unperm', port, status: 'rejected', message: 'invalid label', home, pid: null, command: [] };
    }

    const plistPath = computePlistPath(label);
    if (!existsSync(plistPath)) {
        return { ok: false, action: 'unperm', port, status: 'rejected', message: 'no plist registered', home, pid: null, command: [] };
    }

    // verify it's ours before removing
    try {
        const content = readFileSync(plistPath, 'utf8');
        if (!content.includes(`<string>${label}</string>`)) {
            return { ok: false, action: 'unperm', port, status: 'rejected', message: 'plist label mismatch', home, pid: null, command: [] };
        }
    } catch {
        return { ok: false, action: 'unperm', port, status: 'error', message: 'cannot read plist', home, pid: null, command: [] };
    }

    await execLaunchctl(['bootout', `${guiDomain()}/${label}`], OP_TIMEOUT_MS);
    try { unlinkSync(plistPath); } catch { /* already gone */ }

    return {
        ok: true, action: 'unperm', port, status: 'unpermed',
        message: `removed ${label}`,
        home, pid: null, command: ['launchctl', 'bootout', `${guiDomain()}/${label}`],
        expectedStateAfter: 'offline',
    };
}

export async function stopLaunchdInstance(label: string): Promise<DashboardLifecycleResult> {
    if (!validateLabel(label)) {
        return { ok: false, action: 'stop', port: 0, status: 'rejected', message: 'invalid label', home: null, pid: null, command: [] };
    }
    const { code, stderr } = await execLaunchctl(['bootout', `${guiDomain()}/${label}`], OP_TIMEOUT_MS);
    if (code !== 0 && !stderr.includes('Could not find service')) {
        return { ok: false, action: 'stop', port: 0, status: 'error', message: `bootout failed: ${stderr.trim()}`, home: null, pid: null, command: ['launchctl', 'bootout'] };
    }
    return { ok: true, action: 'stop', port: 0, status: 'stopped', message: 'launchd service stopped (plist kept)', home: null, pid: null, command: ['launchctl', 'bootout'] };
}

export async function startLaunchdInstance(label: string, plistPath: string): Promise<DashboardLifecycleResult> {
    if (!validateLabel(label)) {
        return { ok: false, action: 'start', port: 0, status: 'rejected', message: 'invalid label', home: null, pid: null, command: [] };
    }
    if (!existsSync(plistPath)) {
        return { ok: false, action: 'start', port: 0, status: 'rejected', message: 'plist not found', home: null, pid: null, command: [] };
    }
    const { code, stderr } = await execLaunchctl(['bootstrap', guiDomain(), plistPath], OP_TIMEOUT_MS);
    if (code !== 0) {
        return { ok: false, action: 'start', port: 0, status: 'error', message: `bootstrap failed: ${stderr.trim()}`, home: null, pid: null, command: ['launchctl', 'bootstrap'] };
    }
    return { ok: true, action: 'start', port: 0, status: 'started', message: 'launchd service started', home: null, pid: null, command: ['launchctl', 'bootstrap'] };
}

export async function restartLaunchdInstance(label: string): Promise<DashboardLifecycleResult> {
    if (!validateLabel(label)) {
        return { ok: false, action: 'restart', port: 0, status: 'rejected', message: 'invalid label', home: null, pid: null, command: [] };
    }
    const { code, stderr } = await execLaunchctl(['kickstart', '-k', `${guiDomain()}/${label}`], OP_TIMEOUT_MS);
    if (code !== 0) {
        return { ok: false, action: 'restart', port: 0, status: 'error', message: `kickstart failed: ${stderr.trim()}`, home: null, pid: null, command: ['launchctl', 'kickstart'] };
    }
    return { ok: true, action: 'restart', port: 0, status: 'restarted', message: 'launchd service restarted', home: null, pid: null, command: ['launchctl', 'kickstart', '-k'] };
}
