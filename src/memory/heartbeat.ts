// ─── Heartbeat (Scheduled Jobs + fs.watch) ───────────

import fs from 'fs';
import { settings, HEARTBEAT_JOBS_PATH, loadHeartbeatFile, saveHeartbeatFile } from '../core/config.ts';
import { orchestrateAndCollect, markdownToTelegramHtml, chunkTelegramMessage, telegramBot, telegramActiveChatIds } from '../telegram/bot.ts';
import { broadcast } from '../core/bus.ts';

const heartbeatTimers = new Map();
let heartbeatBusy = false;
const pendingJobs = [];

export function startHeartbeat() {
    stopHeartbeat();
    const { jobs } = loadHeartbeatFile();
    for (const job of jobs) {
        if (!job.enabled || job.schedule?.kind !== 'every') continue;
        const ms = (job.schedule.minutes || 5) * 60_000;
        const timer = setInterval(() => runHeartbeatJob(job), ms);
        timer.unref?.();
        heartbeatTimers.set(job.id, timer);
    }
    const n = heartbeatTimers.size;
    console.log(`[heartbeat] ${n} job${n !== 1 ? 's' : ''} active`);
}

export function stopHeartbeat() {
    for (const timer of heartbeatTimers.values()) clearInterval(timer);
    heartbeatTimers.clear();
}

async function runHeartbeatJob(job) {
    if (heartbeatBusy) {
        if (!pendingJobs.some(j => j.id === job.id)) {
            pendingJobs.push(job);
            console.log(`[heartbeat:${job.name}] queued (${pendingJobs.length} pending)`);
            broadcast('heartbeat_pending', { pending: pendingJobs.length });
        } else {
            console.log(`[heartbeat:${job.name}] already queued, skip`);
        }
        return;
    }
    heartbeatBusy = true;
    try {
        const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const prompt = `[heartbeat:${job.name}] 현재 시간: ${now}\n\n${job.prompt || '정기 점검입니다. 할 일 없으면 [SILENT]로 응답.'}`;
        console.log(`[heartbeat:${job.name}] tick`);
        const result = await orchestrateAndCollect(prompt);

        if (result.includes('[SILENT]')) {
            console.log(`[heartbeat:${job.name}] silent`);
            return;
        }

        console.log(`[heartbeat:${job.name}] response: ${result.slice(0, 80)}`);

        if (telegramBot && settings.telegram?.enabled) {
            const chatIds = settings.telegram.allowedChatIds?.length
                ? settings.telegram.allowedChatIds
                : [...telegramActiveChatIds];
            if (chatIds.length === 0) {
                console.log(`[heartbeat:${job.name}] no telegram chatIds — send a message to the bot first`);
            }
            const html = markdownToTelegramHtml(result);
            const chunks = chunkTelegramMessage(html);
            for (const chatId of chatIds) {
                for (const chunk of chunks) {
                    try {
                        await telegramBot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
                    } catch {
                        await telegramBot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ''));
                    }
                }
            }
        }
    } catch (err) {
        console.error(`[heartbeat:${job.name}] error:`, err.message);
    } finally {
        heartbeatBusy = false;
        drainPending();
    }
}

async function drainPending() {
    if (pendingJobs.length === 0) return;
    const next = pendingJobs.shift();
    broadcast('heartbeat_pending', { pending: pendingJobs.length });
    console.log(`[heartbeat:${next.name}] dequeued (${pendingJobs.length} remaining)`);
    await runHeartbeatJob(next);
}

// ─── fs.watch — auto-reload on file change ───────────

export function watchHeartbeatFile() {
    try {
        let watchDebounce = null;
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
