// Phase 5 — pure helpers + types for the Heartbeat page.
// Pulled out so the page module stays under the 500-line cap and the
// tests can import without dragging in React.

import type {
    HbJob,
    HbSchedule,
    HbScheduleEvery,
    HbScheduleCron,
} from './HeartbeatJobRow';

export type { HbJob, HbSchedule, HbScheduleEvery, HbScheduleCron };

const INTERVAL_RE = /^\d+[smh]$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const TARGET_FALLBACK = ['codex', 'claude', 'copilot', 'gemini'] as const;

export const SECTION_A_KEYS = [
    'heartbeat.enabled',
    'heartbeat.every',
    'heartbeat.activeHours.start',
    'heartbeat.activeHours.end',
    'heartbeat.target',
] as const;

export const PAGE_LOCAL_KEYS = ['heartbeat.jobs', 'heartbeat.md'] as const;

export function validateInterval(value: string): boolean {
    return INTERVAL_RE.test(value.trim());
}

export function validateHHMM(value: string): boolean {
    return HHMM_RE.test(value.trim());
}

export function makeDefaultJob(now: number = Date.now()): HbJob {
    return {
        id: `hb_${now}`,
        name: '',
        enabled: true,
        schedule: { kind: 'every', minutes: 30 },
        prompt: '',
    };
}

export function isHeartbeatSettingsKey(key: string): boolean {
    return (
        key.startsWith('heartbeat.') &&
        key !== 'heartbeat.jobs' &&
        key !== 'heartbeat.md'
    );
}

function safeJob(raw: unknown, index: number): HbJob | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id =
        typeof r['id'] === 'string' && r['id'].trim()
            ? r['id'].trim()
            : `hb_unknown_${index}`;
    const name = typeof r['name'] === 'string' ? r['name'] : '';
    const enabled = r['enabled'] !== false;
    const prompt = typeof r['prompt'] === 'string' ? r['prompt'] : '';
    const sched = r['schedule'];
    let schedule: HbSchedule;
    if (sched && typeof sched === 'object') {
        const s = sched as Record<string, unknown>;
        if (s['kind'] === 'cron' && typeof s['cron'] === 'string') {
            schedule = {
                kind: 'cron',
                cron: s['cron'],
                ...(typeof s['timeZone'] === 'string' && s['timeZone']
                    ? { timeZone: s['timeZone'] }
                    : {}),
            };
        } else {
            const minutes = typeof s['minutes'] === 'number' ? s['minutes'] : 30;
            schedule = {
                kind: 'every',
                minutes,
                ...(typeof s['timeZone'] === 'string' && s['timeZone']
                    ? { timeZone: s['timeZone'] }
                    : {}),
            };
        }
    } else {
        schedule = { kind: 'every', minutes: 30 };
    }
    return { id, name, enabled, schedule, prompt };
}

export function normalizeJobsResponse(payload: unknown): HbJob[] {
    if (!payload || typeof payload !== 'object') return [];
    const jobs = (payload as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs)) return [];
    return jobs
        .map((raw, index) => safeJob(raw, index))
        .filter((job): job is HbJob => job !== null);
}

export function jobScheduleBodyError(schedule: HbSchedule): string | null {
    if (schedule.kind === 'every') {
        const m = (schedule as HbScheduleEvery).minutes;
        if (!Number.isFinite(m) || m <= 0 || !Number.isInteger(m)) {
            return 'Minutes must be a positive integer';
        }
        return null;
    }
    const cron = (schedule as HbScheduleCron).cron?.trim() ?? '';
    if (!cron) return 'Cron expression required';
    if (cron.split(/\s+/).length < 5) return 'Cron must have at least 5 fields';
    return null;
}

export function jobsHaveErrors(jobs: ReadonlyArray<HbJob>): boolean {
    return jobs.some((job) => jobScheduleBodyError(job.schedule) !== null);
}
