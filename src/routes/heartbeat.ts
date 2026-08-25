import type { Express } from 'express';
import type { AuthMiddleware } from './types.js';
import { loadHeartbeatFile, saveHeartbeatFile, isHeartbeatDestination } from '../core/config.js';
import type { HeartbeatDestination } from '../core/config.js';
import { startHeartbeat } from '../memory/heartbeat.js';
import { validateHeartbeatScheduleInput } from '../memory/heartbeat-schedule.js';
import { getEmployees } from '../core/db.js';
import type { EmployeeRow } from '../core/employees.js';
import { stripUndefined } from '../core/strip-undefined.js';

type RunnerFields = Pick<import('../core/config.js').HeartbeatJob, 'runner' | 'employee' | 'command' | 'reportPolicy'>;
export type HeartbeatPutRunnerResult = { ok: true; fields: RunnerFields } | { ok: false; error: string };

/** Resolve the destination a PUT should persist.
 *
 *  Every shipped UI (Classic `normalizeHeartbeatJob`, Manager `safeJob`) rebuilds
 *  each job from a fixed five-field shape, so a field they do not know about is
 *  absent from the body rather than explicitly cleared. Inheriting on absence is
 *  what keeps an ordinary "Save jobs" click from deleting a destination the UI
 *  cannot even display — the same reason runner fields already inherit.
 *
 *  An explicit `null` is the deliberate clear, and is NOT folded into undefined:
 *  doing so would make unsetting impossible from any client. */
export function resolveHeartbeatDestination(
    job: Record<string, unknown>,
    existing: HeartbeatDestination | null | undefined,
): { ok: true; destination: HeartbeatDestination | undefined } | { ok: false; error: string } {
    if (!Object.prototype.hasOwnProperty.call(job, 'destination')) {
        return { ok: true, destination: existing ?? undefined };
    }
    const raw = job['destination'];
    if (raw === null) return { ok: true, destination: undefined };
    if (!isHeartbeatDestination(raw)) return { ok: false, error: 'invalid heartbeat destination' };
    return { ok: true, destination: raw };
}

export function normalizeHeartbeatPutRunnerFields(
    job: Record<string, unknown>,
    existing: RunnerFields | undefined,
    employeeNames: ReadonlySet<string>,
): HeartbeatPutRunnerResult {
    const inherited = (key: keyof RunnerFields): unknown =>
        Object.prototype.hasOwnProperty.call(job, key) ? job[key] : existing?.[key];
    const runnerValue = inherited('runner');
    const runner = runnerValue == null ? undefined : runnerValue;
    const employee = inherited('employee');
    const command = inherited('command');
    const reportPolicy = inherited('reportPolicy');
    if (runner !== undefined && runner !== 'main' && runner !== 'employee' && runner !== 'script') return { ok: false, error: 'invalid heartbeat runner' };
    if (runner === 'employee' && (typeof employee !== 'string' || !employeeNames.has(employee))) return { ok: false, error: 'unknown heartbeat employee' };
    if (runner === 'script' && (!Array.isArray(command) || command.length === 0 || !command.every(part => typeof part === 'string' && part.length > 0))) {
        return { ok: false, error: 'command must be a non-empty string array' };
    }
    if (reportPolicy !== undefined && reportPolicy !== null && reportPolicy !== 'always' && reportPolicy !== 'anomaly_only' && reportPolicy !== 'silent') {
        return { ok: false, error: 'invalid heartbeat report policy' };
    }
    return { ok: true, fields: stripUndefined({
        runner: runner ?? undefined,
        employee: employee == null ? undefined : employee as string,
        command: command == null ? undefined : command as string[],
        reportPolicy: reportPolicy == null ? undefined : reportPolicy as RunnerFields['reportPolicy'],
    }) };
}

export function registerHeartbeatRoutes(app: Express, requireAuth: AuthMiddleware): void {
    app.get('/api/heartbeat', requireAuth, (_req, res) => res.json(loadHeartbeatFile()));

    app.put('/api/heartbeat', requireAuth, (req, res) => {
        const data = req.body;
        if (!data || !Array.isArray(data.jobs)) {
            res.status(400).json({ error: 'jobs array required' });
            return;
        }
        const normalizedJobs = [];
        const existingById = new Map(loadHeartbeatFile().jobs.filter(job => job.id).map(job => [job.id, job]));
        const employeeNames = new Set((getEmployees.all() as EmployeeRow[]).map(employee => employee.name));
        const idPrefix = `hb_${Date.now()}`;
        for (const [index, rawJob] of data.jobs.entries()) {
            const job = (rawJob && typeof rawJob === 'object') ? rawJob as Record<string, unknown> : {};
            const scheduleResult = validateHeartbeatScheduleInput(job["schedule"]);
            const jobId = typeof job["id"] === 'string' && job["id"].trim()
                ? job["id"].trim()
                : `${idPrefix}_${index}`;
            if (!scheduleResult.ok) {
                res.status(400).json({
                    error: 'invalid heartbeat schedule',
                    code: scheduleResult.code,
                    detail: scheduleResult.error,
                    index,
                    jobId,
                });
                return;
            }
            const existing = existingById.get(jobId);
            const runnerResult = normalizeHeartbeatPutRunnerFields(job, existing, employeeNames);
            if (!runnerResult.ok) { res.status(400).json({ error: runnerResult.error, index, jobId }); return; }
            const destResult = resolveHeartbeatDestination(job, existing?.destination);
            if (!destResult.ok) { res.status(400).json({ error: destResult.error, index, jobId }); return; }
            normalizedJobs.push(stripUndefined({
                id: jobId,
                name: typeof job["name"] === 'string' ? job["name"] : '',
                enabled: job["enabled"] !== false,
                schedule: scheduleResult.schedule,
                prompt: typeof job["prompt"] === 'string' ? job["prompt"] : '',
                ...runnerResult.fields,
                destination: destResult.destination,
            }));
        }
        const payload = { jobs: normalizedJobs };
        saveHeartbeatFile(payload);
        startHeartbeat();
        res.json(payload);
    });
}
