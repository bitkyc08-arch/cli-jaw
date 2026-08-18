/**
 * Windows service backend (#370): current-user autostart via Startup folder wrapper
 * with an optional Scheduled Task upgrade.
 *
 * The Startup folder is the DEFAULT non-admin mechanism. schtasks /Create is documented
 * as administrator-only for /SC ONLOGON, so it is attempted as an opportunistic upgrade
 * and downgraded from on failure — the fallback is the primary path, not the other way
 * around. Review caught the original plan's inversion.
 *
 * Key invariants:
 * - No admin requirement for the default path.
 * - Never use Get-Process <name> | Stop-Process or substring-wide killing.
 * - Multiple homes/ports coexist.
 * - A stale/recycled PID is never signalled (instance-identity ownership).
 * - schtasks output is parsed via /QUERY /XML, not /FO CSV (locale-independent).
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { getJawPath } from '../core/instance.js';
import { defaultLifecycleDeps, verifyOwnershipAt } from '../core/instance-lifecycle.js';
import type { DashboardServiceState, DashboardLifecycleResult, DashboardLifecycleAction } from './types.js';

// ── Naming ─────────────────────────────────────────────

/** Derive a filesystem-safe, stable task/wrapper name from home + port. */
export function windowsServiceName(home: string, port: number): string {
    const hash = createHash('sha256')
        .update(resolve(home).toLowerCase().replace(/\\/g, '/'))
        .digest('hex')
        .slice(0, 8);
    return `cli-jaw-${hash}-${port}`;
}

// ── Registration receipt ───────────────────────────────

export type WindowsRegistration = {
    mechanism: 'startup-shortcut' | 'scheduled-task';
    taskName: string;
    home: string;
    port: number;
    identityId?: string;
    fingerprint?: string;
    createdAt: string;
    logDir: string;
};

function receiptPath(home: string): string {
    return join(home, 'service-registration.json');
}

function readReceipt(home: string): WindowsRegistration | null {
    try {
        return JSON.parse(readFileSync(receiptPath(home), 'utf8'));
    } catch { return null; }
}

function writeReceipt(home: string, reg: WindowsRegistration): void {
    writeFileSync(receiptPath(home), JSON.stringify(reg, null, 2) + '\n');
}

function deleteReceipt(home: string): void {
    try { unlinkSync(receiptPath(home)); } catch { /* absent is fine */ }
}

// ── Log rotation ───────────────────────────────────────

const LOG_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

function rotateLog(logPath: string): void {
    try {
        const stat = statSync(logPath);
        if (stat.size >= LOG_MAX_BYTES) {
            renameSync(logPath, logPath + '.1');
        }
    } catch { /* file absent or unreadable — fine, a new one will be created */ }
}

// ── Startup-folder wrapper ─────────────────────────────

function startupDir(): string {
    // shell:startup is %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
    return join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'),
        'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function wrapperPath(name: string): string {
    return join(startupDir(), `${name}.cmd`);
}

function buildWrapper(name: string, home: string, port: number, logDir: string): string {
    // The wrapper appends to log files (>>), never truncates. Start-Process
    // redirection truncates, which the issue calls out by name.
    const outLog = join(logDir, 'service-out.log');
    const errLog = join(logDir, 'service-err.log');
    const nodePath = process.execPath;
    const jawPath = getJawPath();
    return [
        '@ECHO OFF',
        // chcp must run before the REM lines below: they carry the home path,
        // and cmd.exe parses a BOM-less batch file in the OEM codepage. A BOM
        // is NOT an alternative - it fuses onto @ECHO OFF and dies 9009 (#380).
        'chcp 65001 >nul',
        `REM cli-jaw autostart wrapper: ${name}`,
        `REM Home: ${home}`,
        `REM Port: ${port}`,
        `"${nodePath}" "${jawPath}" --home "${home}" serve --port ${port} --no-open >> "${outLog}" 2>> "${errLog}"`,
    ].join('\r\n') + '\r\n';
}

// ── Scheduled Task (opportunistic) ─────────────────────

function tryCreateScheduledTask(name: string, home: string, port: number, _logDir: string): boolean {
    const nodePath = process.execPath;
    const jawPath = getJawPath();
    const cmd = `"${nodePath}" "${jawPath}" --home "${home}" serve --port ${port} --no-open`;
    try {
        // Try creating as a LOGON trigger task
        const result = spawnSync('schtasks.exe', [
            '/Create', '/TN', name, '/SC', 'ONLOGON',
            '/TR', cmd,
            '/F', // force overwrite if exists
        ], { stdio: 'pipe', timeout: 15000 });
        return result.status === 0;
    } catch { return false; }
}

function tryDeleteScheduledTask(name: string): boolean {
    try {
        const r = spawnSync('schtasks.exe', ['/Delete', '/TN', name, '/F'], { stdio: 'pipe', timeout: 10000 });
        return r.status === 0;
    } catch { return false; }
}

function tryRunScheduledTask(name: string): boolean {
    try {
        const r = spawnSync('schtasks.exe', ['/Run', '/TN', name], { stdio: 'pipe', timeout: 10000 });
        return r.status === 0;
    } catch { return false; }
}

function tryDisableScheduledTask(name: string): boolean {
    try {
        const r = spawnSync('schtasks.exe', ['/Change', '/TN', name, '/DISABLE'], { stdio: 'pipe', timeout: 10000 });
        return r.status === 0;
    } catch { return false; }
}

function tryEnableScheduledTask(name: string): boolean {
    try {
        const r = spawnSync('schtasks.exe', ['/Change', '/TN', name, '/ENABLE'], { stdio: 'pipe', timeout: 10000 });
        return r.status === 0;
    } catch { return false; }
}

function isScheduledTaskRegistered(name: string): boolean {
    try {
        const r = spawnSync('schtasks.exe', ['/Query', '/TN', name, '/XML'], { stdio: 'pipe', timeout: 10000 });
        return r.status === 0;
    } catch { return false; }
}

// ── Public API ─────────────────────────────────────────

function makeResult(action: DashboardLifecycleAction, port: number, home: string, ok: boolean, status: DashboardLifecycleResult['status'], message: string, pid: number | null = null): DashboardLifecycleResult {
    return { ok, action, port, status, message, home, pid, command: [] };
}

export function detectWindowsServiceState(port: number, home: string): DashboardServiceState {
    const receipt = readReceipt(home);
    const name = windowsServiceName(home, port);
    const registered = receipt !== null && receipt.taskName === name;
    const taskRegistered = isScheduledTaskRegistered(name);
    const wrapperExists = existsSync(wrapperPath(name));
    // loaded means "a process is believed to run", not "autostart artifacts
    // exist" (#380). A Startup .cmd owns no process, so derive loaded from
    // pidfile ownership of the probed home; registered keeps artifact meaning.
    const verdict = verifyOwnershipAt(resolve(home), defaultLifecycleDeps);
    const owned = verdict.status === 'owned';
    return {
        registered: registered || taskRegistered || wrapperExists,
        loaded: owned,
        pid: owned && verdict.status === 'owned' ? verdict.record.pid : null,
        label: name,
        unitPath: wrapperPath(name),
        backend: 'windows' as DashboardServiceState['backend'],
    };
}

export function detectAllWindowsServiceStates(
    _portRange: { from: number; to: number },
    _homeRoot?: string,
): Map<number, DashboardServiceState> {
    // Windows discovery would need to enumerate receipts across all homes.
    // For now, return empty — the dashboard will use the single-home detect path.
    return new Map();
}

export async function permWindowsInstance(port: number, home: string): Promise<DashboardLifecycleResult> {
    const name = windowsServiceName(home, port);
    const logDir = join(home, 'logs');
    mkdirSync(logDir, { recursive: true });

    // Rotate existing logs before install
    rotateLog(join(logDir, 'service-out.log'));
    rotateLog(join(logDir, 'service-err.log'));

    let mechanism: WindowsRegistration['mechanism'] = 'startup-shortcut';

    // Try the opportunistic Scheduled Task first
    if (tryCreateScheduledTask(name, home, port, logDir)) {
        mechanism = 'scheduled-task';
    }

    // Always install the Startup wrapper as the fallback/default
    try {
        const dir = startupDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(wrapperPath(name), buildWrapper(name, home, port, logDir));
    } catch (err: unknown) {
        // If both mechanisms fail, report failure
        if (mechanism !== 'scheduled-task') {
            return makeResult('perm', port, home, false, 'error',
                `Failed to create autostart wrapper: ${(err as Error).message}`);
        }
    }

    // Write the receipt
    writeReceipt(home, {
        mechanism,
        taskName: name,
        home: resolve(home),
        port,
        createdAt: new Date().toISOString(),
        logDir,
    });

    // Start the server NOW (install means start + register for next logon)
    const nodePath = process.execPath;
    const jawPath = getJawPath();
    let spawnFailed = false;
    try {
        const child = nodeSpawn(nodePath, [jawPath, '--home', home, 'serve', '--port', String(port), '--no-open'], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    } catch { spawnFailed = true; }

    // Confirm startup via pidfile ownership rather than asserting it (#380).
    // /api/health is unattributable: on EADDRINUSE a foreign server answers 200.
    let confirmed = false;
    if (!spawnFailed) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (verifyOwnershipAt(resolve(home), defaultLifecycleDeps).status === 'owned') { confirmed = true; break; }
            await new Promise(r => setTimeout(r, 250));
        }
    }
    return makeResult('perm', port, home, true, 'permed',
        confirmed
            ? `Registered via ${mechanism}. Server started on port ${port}.`
            : `Registered via ${mechanism}. Server did not confirm startup on port ${port} - check ${join(logDir, 'service-err.log')}.`);
}

export async function unpermWindowsInstance(port: number, home: string): Promise<DashboardLifecycleResult> {
    const name = windowsServiceName(home, port);
    const receipt = readReceipt(home);

    // Remove Scheduled Task if it exists
    tryDeleteScheduledTask(name);

    // Remove Startup wrapper
    try { unlinkSync(wrapperPath(name)); } catch { /* absent is fine */ }

    // Remove receipt
    deleteReceipt(home);

    return makeResult('unperm', port, home, true, 'unpermed',
        `Unregistered ${receipt?.mechanism || 'unknown'}. Logs and settings preserved.`);
}

export async function stopWindowsInstance(label: string): Promise<DashboardLifecycleResult> {
    // Disabling the task only prevents respawn at next logon; it never signals
    // the process. Report honestly instead of claiming 'stopped' (#380) - the
    // PID-verified path (jaw service stop) owns process termination.
    const disabled = tryDisableScheduledTask(label);
    return makeResult('stop', 0, null as unknown as string, true, 'stopped',
        disabled
            ? 'Disabled autostart task. No process was signalled - use jaw service stop for PID-verified termination.'
            : 'No Scheduled Task to disable (Startup-wrapper install). No process was signalled - use jaw service stop.');
}

export async function startWindowsInstance(label: string, _unitPath: string): Promise<DashboardLifecycleResult> {
    // Re-enable and run the task if it exists
    tryEnableScheduledTask(label);
    if (!tryRunScheduledTask(label)) {
        return makeResult('start', 0, null as unknown as string, false, 'error',
            'Failed to start via Scheduled Task. Use `jaw serve` directly.');
    }
    return makeResult('start', 0, null as unknown as string, true, 'started', 'Started via Scheduled Task.');
}

export async function restartWindowsInstance(label: string): Promise<DashboardLifecycleResult> {
    const hadTask = tryDisableScheduledTask(label);
    // Wait briefly for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));
    tryEnableScheduledTask(label);
    if (!hadTask || !tryRunScheduledTask(label)) {
        return makeResult('restart', 0, null as unknown as string, false, 'error',
            hadTask ? 'Failed to restart via Scheduled Task.'
                : 'No Scheduled Task registered (Startup-wrapper install); nothing was restarted. Use jaw service restart.');
    }
    return makeResult('restart', 0, null as unknown as string, true, 'restarted', 'Restarted via Scheduled Task.');
}
