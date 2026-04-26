// ─── Heartbeat (Scheduled Jobs + fs.watch) ───────────

import fs from 'fs';
import { settings, HEARTBEAT_JOBS_PATH, loadHeartbeatFile, saveHeartbeatFile } from '../core/config.js';
import { orchestrateAndCollect } from '../orchestrator/collect.js';
import { broadcast } from '../core/bus.js';
import { sendChannelOutput } from '../messaging/send.js';
import { getState } from '../orchestrator/state-machine.js';
import {
    describeHeartbeatSchedule,
    formatHeartbeatNow,
    getHeartbeatMinuteSlotKey,
    getHeartbeatScheduleTimeZone,
    matchesHeartbeatCron,
    normalizeHeartbeatSchedule,
    startHeartbeatCronLoop,
    validateHeartbeatCron,
} from './heartbeat-schedule.js';

const heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();
const heartbeatCronSlots = new Map<string, string>();
let heartbeatBusy = false;
type HeartbeatPendingReason = 'busy' | 'pabcd_active';
type HeartbeatPendingPolicy = 'defer';
interface PendingHeartbeatJob {
    job: Record<string, any>;
    reason: HeartbeatPendingReason;
    policy?: HeartbeatPendingPolicy;
}
const pendingJobs: PendingHeartbeatJob[] = [];

function pendingSnapshot(reason?: HeartbeatPendingReason, policy?: HeartbeatPendingPolicy) {
    const deferredPending = pendingJobs.filter(item => item.reason === 'pabcd_active').length;
    return {
        pending: pendingJobs.length,
        deferredPending,
        ...(reason ? { reason } : {}),
        ...(policy ? { policy } : {}),
    };
}

function queueHeartbeatJob(
    job: Record<string, any>,
    reason: HeartbeatPendingReason,
    policy?: HeartbeatPendingPolicy,
): boolean {
    if (pendingJobs.some(item => item.job.id === job.id)) return false;
    pendingJobs.push({ job, reason, policy });
    broadcast('heartbeat_pending', {
        ...pendingSnapshot(reason, policy),
        jobId: job.id,
        jobName: job.name,
    });
    return true;
}

export function getHeartbeatRuntimeState() {
    return pendingSnapshot();
}

export function startHeartbeat() {
    stopHeartbeat();
    const { jobs } = loadHeartbeatFile();
    for (const job of jobs) {
        if (!job?.enabled) continue;
        const schedule = normalizeHeartbeatSchedule(job.schedule);
        if (schedule.kind === 'cron') {
            const cronError = validateHeartbeatCron(schedule.cron);
            if (cronError) {
                console.warn(`[heartbeat:${job.name}] invalid cron "${schedule.cron}": ${cronError}`);
                continue;
            }
            scheduleCronJob(job);
            continue;
        }
        const ms = schedule.minutes * 60_000;
        const timer = setInterval(() => runHeartbeatJob(job), ms);
        timer.unref?.();
        heartbeatTimers.set(job.id, timer);
    }
    const n = heartbeatTimers.size;
    console.log(`[heartbeat] ${n} job${n !== 1 ? 's' : ''} active`);
}

export function stopHeartbeat() {
    for (const timer of heartbeatTimers.values()) clearTimeout(timer);
    heartbeatTimers.clear();
    heartbeatCronSlots.clear();
}

async function runHeartbeatJob(job: Record<string, any>) {
    if (getState('default') !== 'IDLE') {
        const queued = queueHeartbeatJob(job, 'pabcd_active', 'defer');
        console.log(`[heartbeat:${job.name}] ${queued ? 'deferred' : 'already deferred'} during active PABCD (${pendingJobs.length} pending)`);
        return;
    }
    if (heartbeatBusy) {
        if (queueHeartbeatJob(job, 'busy')) {
            console.log(`[heartbeat:${job.name}] queued (${pendingJobs.length} pending)`);
        } else {
            console.log(`[heartbeat:${job.name}] already queued, skip`);
        }
        return;
    }
    heartbeatBusy = true;
    try {
        const schedule = normalizeHeartbeatSchedule(job.schedule);
        const timeZone = getHeartbeatScheduleTimeZone(schedule);
        const now = formatHeartbeatNow(schedule);
        const prompt = `[heartbeat:${job.name}] 현재 시간: ${now} (${timeZone})\n\nBefore responding, you MUST search memory (cli-jaw memory search) for recent conversation context, user preferences, and ongoing tasks. Use this context to ground your response.\n\n${job.prompt || '정기 점검입니다. 할 일 없으면 [SILENT]로 응답.'}`;
        console.log(`[heartbeat:${job.name}] tick (${describeHeartbeatSchedule(schedule)})`);
        const result: string = String(await orchestrateAndCollect(prompt, { origin: 'heartbeat' }));

        if (result.includes('[SILENT]')) {
            console.log(`[heartbeat:${job.name}] silent`);
            return;
        }

        console.log(`[heartbeat:${job.name}] response: ${result.slice(0, 80)}`);

        // Send heartbeat result via active messaging channel
        const sendResult = await sendChannelOutput({
            channel: 'active',
            type: 'text',
            text: result,
        });
        if (!sendResult.ok) {
            console.error(`[heartbeat:${job.name}] send failed: ${sendResult.error}`);
        }
    } catch (err) {
        console.error(`[heartbeat:${job.name}] error:`, (err as Error).message);
    } finally {
        heartbeatBusy = false;
        drainPending();
    }
}

export async function drainPending() {
    if (pendingJobs.length === 0) return;
    const next = pendingJobs.shift()?.job;
    if (!next) return;
    broadcast('heartbeat_pending', pendingSnapshot());
    console.log(`[heartbeat:${next.name}] dequeued (${pendingJobs.length} remaining)`);
    await runHeartbeatJob(next);
}

function scheduleCronJob(job: Record<string, any>) {
    const armNextTick = (tick: () => void) => {
        const timer = setTimeout(tick, msUntilNextMinute());
        timer.unref?.();
        heartbeatTimers.set(job.id, timer);
    };
    startHeartbeatCronLoop(() => maybeRunCronJob(job), armNextTick);
}

function maybeRunCronJob(job: Record<string, any>) {
    const schedule = normalizeHeartbeatSchedule(job.schedule);
    if (schedule.kind !== 'cron') return;
    const timeZone = getHeartbeatScheduleTimeZone(schedule);
    if (!matchesHeartbeatCron(schedule.cron, new Date(), timeZone)) return;
    const slotKey = getHeartbeatMinuteSlotKey(schedule);
    if (heartbeatCronSlots.get(job.id) === slotKey) return;
    heartbeatCronSlots.set(job.id, slotKey);
    void runHeartbeatJob(job);
}

function msUntilNextMinute(): number {
    const now = Date.now();
    const remainder = now % 60_000;
    return (remainder === 0 ? 60_000 : 60_000 - remainder) + 250;
}

// ─── fs.watch — auto-reload on file change ───────────

export function watchHeartbeatFile() {
    try {
        let watchDebounce: ReturnType<typeof setTimeout> | undefined;
        fs.watch(HEARTBEAT_JOBS_PATH, () => {
            clearTimeout(watchDebounce);
            watchDebounce = setTimeout(() => {
                console.log('[heartbeat] file changed — reloading');
                startHeartbeat();
            }, 500);
        });
    } catch { /* expected: heartbeat file doesn't exist yet — created on first save */ }
}

// Re-export for route handlers
export { loadHeartbeatFile, saveHeartbeatFile };
