import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { PIDFILE_PATH } from './config.js';

export interface ProcessStartTime {
    value: string;
    source: 'linux-proc' | 'macos-ps' | 'windows-filetime';
}

export interface PidfileRecord {
    pid: number;
    /** OS process-table time. NEVER Date.now(): recycled PIDs must not match. */
    startedAt: ProcessStartTime;
    port: number;
    home: string;
    version: string;
}

export type PidProbe = { status: 'alive' } | { status: 'dead' } | { status: 'permission-denied'; code: string };

export function probePid(pid: number, kill: (pid: number, signal: number) => void = process.kill): PidProbe {
    if (!Number.isInteger(pid) || pid <= 0) return { status: 'dead' };
    try { kill(pid, 0); return { status: 'alive' }; }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        return code === 'EPERM' ? { status: 'permission-denied', code } : { status: 'dead' };
    }
}

export interface LifecycleDeps {
    readFile: (path: string) => string | null;
    writeFileAtomic: (path: string, data: string) => void;
    removeFile: (path: string) => void;
    probe: (pid: number) => PidProbe;
    processStartedAt: (pid: number) => ProcessStartTime | null;
}

export type OwnershipVerdict =
    | { status: 'owned'; record: PidfileRecord }
    | { status: 'no-pidfile' }
    | { status: 'already-stopped'; record: PidfileRecord }
    | { status: 'stale'; record: PidfileRecord; reason: string }
    | { status: 'foreign'; record: PidfileRecord; reason: string }
    | { status: 'permission-denied'; record: PidfileRecord }
    | { status: 'unverifiable'; record: PidfileRecord; reason: string };

const SOURCES = new Set(['linux-proc', 'macos-ps', 'windows-filetime']);
function readPidfile(deps: LifecycleDeps, pidfilePath: string = PIDFILE_PATH): PidfileRecord | null {
    const raw = deps.readFile(pidfilePath);
    if (raw === null) return null;
    try {
        const r = JSON.parse(raw) as Partial<PidfileRecord>;
        const s = r.startedAt as Partial<ProcessStartTime> | undefined;
        if (!Number.isInteger(r.pid) || (r.pid ?? 0) <= 0 || !Number.isInteger(r.port) || (r.port ?? 0) <= 0) return null;
        if (!s || typeof s.value !== 'string' || !s.value || !SOURCES.has(String(s.source))) return null;
        if (typeof r.home !== 'string' || !r.home || typeof r.version !== 'string' || !r.version) return null;
        return r as PidfileRecord;
    } catch { return null; }
}

function sameStartTime(a: ProcessStartTime, b: ProcessStartTime): boolean {
    return a.source === b.source && a.value === b.value;
}

export function verifyOwnership(home: string, deps: LifecycleDeps): OwnershipVerdict {
    return verifyOwnershipOfPidfile(home, deps, PIDFILE_PATH);
}

/**
 * Home-parameterized ownership check (#380): verifyOwnership reads the
 * module-frozen PIDFILE_PATH, which only answers for our own home. The
 * dashboard probes foreign homes (defaultHomeForPort), so it needs the
 * pidfile that lives inside the probed home.
 */
export function verifyOwnershipAt(home: string, deps: LifecycleDeps): OwnershipVerdict {
    return verifyOwnershipOfPidfile(home, deps, join(home, 'jaw.pid.json'));
}

function verifyOwnershipOfPidfile(home: string, deps: LifecycleDeps, pidfilePath: string): OwnershipVerdict {
    const record = readPidfile(deps, pidfilePath);
    if (!record) return { status: 'no-pidfile' };
    if (record.home !== home) return { status: 'foreign', record, reason: `pidfile belongs to ${record.home}` };
    const probe = deps.probe(record.pid);
    if (probe.status === 'dead') return { status: 'already-stopped', record };
    if (probe.status === 'permission-denied') return { status: 'permission-denied', record };
    const actual = deps.processStartedAt(record.pid);
    if (!actual) return { status: 'unverifiable', record, reason: `OS start time unavailable for pid ${record.pid}` };
    if (!sameStartTime(record.startedAt, actual)) return { status: 'stale', record, reason: `pid ${record.pid} start time does not match the pidfile` };
    return { status: 'owned', record };
}

export function writePidfile(record: PidfileRecord, deps: LifecycleDeps): void {
    deps.writeFileAtomic(PIDFILE_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

export function clearPidfileIfOurs(record: PidfileRecord, deps: LifecycleDeps): boolean {
    const current = readPidfile(deps);
    if (!current || current.pid !== record.pid || !sameStartTime(current.startedAt, record.startedAt)) return false;
    deps.removeFile(PIDFILE_PATH);
    return true;
}

export function parseWindowsStartTime(raw: string): ProcessStartTime | null {
    const value = raw.trim();
    return /^\d+$/.test(value) ? { value, source: 'windows-filetime' } : null;
}

export function parsePosixStartTime(raw: string): ProcessStartTime | null {
    const parsed = Date.parse(raw.trim());
    return Number.isFinite(parsed) ? { value: String(Math.trunc(parsed / 1000) * 1000), source: 'macos-ps' } : null;
}

function parseLinuxStartTime(raw: string): ProcessStartTime | null {
    const end = raw.lastIndexOf(')');
    const value = end < 0 ? undefined : raw.slice(end + 1).trim().split(/\s+/)[19];
    return value && /^\d+$/.test(value) ? { value, source: 'linux-proc' } : null;
}

export function processStartedAt(pid: number): ProcessStartTime | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        if (process.platform === 'linux') return parseLinuxStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
        if (process.platform === 'darwin') return parsePosixStartTime(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }));
        if (process.platform === 'win32') return windowsStartTimeCached(pid);
    } catch { return null; }
    return null;
}

// Start time is immutable per OS process, and every consumer only compares it
// for equality against a recorded value - a stale memo for a recycled PID
// fails sameStartTime and yields the conservative 'stale' verdict, never a
// false 'owned' (#382). The powershell probe costs ~200ms per call and had no
// timeout, so a wedged PowerShell hung the CLI.
const windowsStartTimes = new Map<number, ProcessStartTime | null>();
function windowsStartTimeCached(pid: number): ProcessStartTime | null {
    const cached = windowsStartTimes.get(pid);
    if (cached !== undefined) return cached;
    let value: ProcessStartTime | null = null;
    try {
        value = parseWindowsStartTime(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', timeout: 5000 }));
    } catch { value = null; }
    // Do not memoize a dead-PID null: the PID could be spawned later.
    if (value !== null) windowsStartTimes.set(pid, value);
    return value;
}

export const defaultLifecycleDeps: LifecycleDeps = {
    readFile: path => { try { return fs.readFileSync(path, 'utf8'); } catch { return null; } },
    writeFileAtomic: (path, data) => {
        fs.mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, path);
    },
    removeFile: path => { try { fs.unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } },
    probe: pid => probePid(pid),
    processStartedAt,
};
