// ─── Agent Spawn + Kill/Steer/Queue ──────────────────

import fs from 'fs';
import os from 'os';
import crypto from 'node:crypto';
import { join } from 'path';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { broadcast } from '../core/bus.js';
import { settings, UPLOADS_DIR, detectCli, normalizeModelForCli } from '../core/config.js';
import {
    clearEmployeeSession, getSession, updateSession, insertMessage, insertMessageWithTrace, getRecentMessages, getEmployees,
    listQueuedMessages, insertQueuedMessage, deleteQueuedMessage,
    getSessionBucket, upsertSessionBucket, clearSessionBucket,
} from '../core/db.js';
import { getSystemPrompt, regenerateB } from '../prompt/builder.js';
import { extractSessionId, extractFromEvent, extractFromAcpUpdate, extractOutputChunk, logEventSummary, flushClaudeBuffers } from './events.js';
import { detectSmokeResponse, buildContinuationPrompt } from './smoke-detector.js';
import { saveUpload as _saveUpload, buildMediaPrompt, buildMediaPromptMany, type SaveUploadOptions } from '../../lib/upload.js';
import { getMemoryFlushFilePath, getMemoryStatus } from '../memory/runtime.js';
import { resolveMainCli, consumePendingBootstrapPrompt } from '../core/main-session.js';
import {
    getSessionOwnershipGeneration,
    persistMainSession,
} from './session-persistence.js';
import { shouldInvalidateResumeSession } from './resume-classifier.js';
import { groupQueueKey } from '../messaging/session-key.js';
import type { RuntimeOrigin, RemoteTarget } from '../messaging/types.js';
import { isCompactMarkerRow } from '../core/compact.js';
import { isRuntimeSettingsMutationInFlight, waitForRuntimeSettingsIdle } from '../core/runtime-settings-gate.js';
import { hasBlockingWorkers, hasPendingWorkerReplays, getActiveWorkers, clearAllWorkers } from '../orchestrator/worker-registry.js';
import { handleAgentExit, setSpawnAgent, setMainMetaHandler } from './lifecycle-handler.js';
import { buildServicePath } from '../core/runtime-path.js';
import { resolveOrcScope } from '../orchestrator/scope.js';
import { beginLiveRun, appendLiveRunText, clearLiveRun, replaceLiveRunTools, appendLiveRunTool } from './live-run-state.js';
import {
    memoryFlushCounter as _memoryFlushCounter,
    flushCycleCount as _flushCycleCount,
    setSpawnRef as setMemorySpawnRef,
    triggerMemoryFlush,
} from './memory-flush-controller.js';
import { applyCliEnvDefaults, buildSessionResumeKey, ensureOpencodeAlwaysAllowPermissions } from './spawn-env.js';
import {
    buildOpencodeRuntimeSnapshot,
    buildOpencodeSpawnAudit,
    pushOpencodeRawEvent,
    resolveOpencodeBinary,
} from './opencode-diagnostics.js';
import type { SpawnContext, ToolEntry } from '../types/agent.js';
import { asCliEventRecord, discriminate, fieldString, type CliEventRecord } from '../types/cli-events.js';

// ─── State ───────────────────────────────────────────

export let activeProcess: ChildProcess | null = null;
export const activeProcesses = new Map<string, ChildProcess>(); // agentId → child process

// Current Boss main session context — set when a mainManaged spawnAgent starts,
// cleared on exit. Used by dispatch routes to capture the original channel
// (web/telegram/discord + chatId) so that disconnected worker results can be
// replayed to the correct scope instead of defaulting to 'system'.
export interface MainSessionMeta {
    origin: string;
    target?: string;
    chatId?: string | number;
    requestId?: string;
    scopeId?: string;
}
let currentMainMeta: MainSessionMeta | null = null;
export function getCurrentMainMeta(): MainSessionMeta | null {
    return currentMainMeta;
}
export function setCurrentMainMeta(meta: MainSessionMeta | null): void {
    currentMainMeta = meta;
}

interface SessionRow {
    cli?: string;
    model?: string;
    permissions?: string;
    session_id?: string | null;
    working_dir?: string | null;
    effort?: string;
}

interface RecentMessageRow {
    role?: string;
    content?: string;
    trace?: string;
}

interface SessionBucketRow {
    session_id?: string | null;
    model?: string | null;
    resume_key?: string | null;
}

type SpawnPromiseResult = { text: string; code: number };

interface CopilotSpawnContext extends SpawnContext {
    thinkingBuf: string;
}

/**
 * Recursively kill a process tree using pgrep -P.
 * Codex sub-agents spawn children with separate PGIDs,
 * so process.kill(-pid) won't reach them.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* best effort */ }
        return;
    }
    let childPids: number[] = [];
    try {
        const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 3000 });
        childPids = out.trim().split('\n').filter(Boolean).map(Number).filter(n => n > 0);
    } catch { /* no children or pgrep failed */ }
    for (const cpid of childPids) {
        killProcessTree(cpid, signal);
    }
    try { process.kill(pid, signal); } catch { /* already dead */ }
}

export function killAgentById(agentId: string): boolean {
    const proc = activeProcesses.get(agentId);
    if (!proc) return false;
    try {
        if (proc.pid) {
            killProcessTree(proc.pid, 'SIGTERM');
        } else {
            proc.kill('SIGTERM');
        }
        setTimeout(() => {
            try {
                if (proc.pid) {
                    killProcessTree(proc.pid, 'SIGKILL');
                } else {
                    proc.kill('SIGKILL');
                }
            } catch { /* already dead */ }
            proc.stdin?.destroy();
            proc.stdout?.destroy();
            proc.stderr?.destroy();
        }, 3_000);
        return true;
    } catch {
        return false;
    }
}
export { memoryFlushCounter, flushCycleCount } from './memory-flush-controller.js';

type QueueItem = {
    id: string;
    prompt: string;
    source: RuntimeOrigin;
    scope: string;
    target?: RemoteTarget;
    chatId?: string | number;
    requestId?: string;
    ts: number;
};

function normalizeQueueItem(row: { id: string; payload: string }): QueueItem[] {
    try {
        const parsed = JSON.parse(row.payload) as Partial<QueueItem>;
        if (typeof parsed?.id !== 'string' || typeof parsed?.prompt !== 'string' || typeof parsed?.source !== 'string') {
            return [];
        }
        return [{
            id: parsed.id,
            prompt: parsed.prompt,
            source: parsed.source,
            scope: 'default',
            target: parsed.target,
            chatId: parsed.chatId,
            requestId: parsed.requestId,
            ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
        }];
    } catch {
        return [];
    }
}

function loadPersistedQueue(): QueueItem[] {
    return (listQueuedMessages.all() as Array<{ id: string; payload: string }>).flatMap(normalizeQueueItem);
}

export const messageQueue: QueueItem[] = loadPersistedQueue();
if (messageQueue.length > 0) {
    console.log(`[queue] recovered ${messageQueue.length} persisted message(s) from previous session`);
}
let queueProcessing = false;

// ─── 429 Retry Timer State ──────────────────────────
// INVARIANT: single-main — 동시에 1개의 main spawnAgent만 존재한다고 가정.
// 멀티 main task 도입 시 request-id 키 맵으로 전환 필요.
let retryPendingTimer: ReturnType<typeof setTimeout> | null = null;
let retryPendingResolve: ((v: { text: string; code: number }) => void) | null = null;
let retryPendingOrigin: string | null = null;
let retryPendingIsEmployee = false;
let mainSpawnStarting = false;
let cancelPendingMainSpawn: ((reason: string) => void) | null = null;

/** busy = process alive OR retry timer pending OR main spawn waiting on settings gate */
export function isAgentBusy(): boolean {
    return !!activeProcess || !!retryPendingTimer || mainSpawnStarting;
}

/**
 * Cancel pending retry timer AND resolve the dangling Promise.
 *
 * @param resumeQueue - true: 취소 후 대기 메시지 실행 (settings 변경 등)
 *                      false: 큐도 중단 (stop/steer 의도)
 *
 * 취소 규약: broadcast agent_done(error:true) → collect.ts L39가 수집함.
 */
export function clearRetryTimer(resumeQueue = true): void {
    if (retryPendingTimer) {
        clearTimeout(retryPendingTimer);
        retryPendingTimer = null;
        console.log('[jaw:retry] timer cancelled');

        if (retryPendingResolve) {
            broadcast('agent_done', {
                text: '⏹️ 재시도 취소됨',
                error: true,
                origin: retryPendingOrigin || 'web',
                ...(retryPendingIsEmployee ? { isEmployee: true } : {}),
            }, retryPendingIsEmployee ? 'internal' : 'public');
            retryPendingResolve({ text: '', code: -1 });
            retryPendingResolve = null;
            retryPendingOrigin = null;
            retryPendingIsEmployee = false;
        }
        if (resumeQueue) processQueue();
    }
}

// ─── Fallback Retry State ────────────────────────────
// key: originalCli, value: { fallbackCli, retriesLeft }
const FALLBACK_MAX_RETRIES = 3;
const fallbackState = new Map();

export function resetFallbackState() {
    clearRetryTimer(true);  // settings 변경 = 큐 재개 OK
    fallbackState.clear();
    console.log('[jaw:fallback] state reset');
}

export function getFallbackState() {
    return Object.fromEntries(fallbackState);
}

// ─── Kill / Steer ────────────────────────────────────

// [I2] Per-process kill reason map (replaces global variable to avoid cross-process confusion)
const killReasons = new Map<number, string>();

/** Get kill reason for a process (by PID), consuming it */
function consumeKillReason(pid: number | undefined): string | null {
    if (!pid) return null;
    const reason = killReasons.get(pid) ?? null;
    if (reason) killReasons.delete(pid);
    return reason;
}

/**
 * Fix A: 사용자 stop은 메모리 큐 + DB persisted_queue + frontend pending row를
 * 모두 폐기한다. exit handler의 processQueue() 자동 드레인이 stop 직후 잔존
 * 메시지를 "스스로 steer" 처럼 실행하던 회귀를 차단.
 */
function purgeQueueOnStop(reason: string) {
    if (messageQueue.length === 0) return;
    const dropped = messageQueue.length;
    for (const item of messageQueue.splice(0)) {
        try { deleteQueuedMessage.run(item.id); } catch { /* best-effort */ }
    }
    console.log(`[jaw:stop] cleared ${dropped} pending message(s) (reason=${reason})`);
    broadcast('queue_update', { pending: 0 });
}

/**
 * Fix C2: 사용자 stop 시 worker-registry 도 비운다.
 * gateway.submitMessage가 isAgentBusy() 외에 hasBlockingWorkers()/hasPendingWorkerReplays()
 * 도 검사하므로, 이걸 비우지 않으면 stop 직후 새 메시지가 busy 분기 → 큐로 떨어지고
 * 프론트는 (1) 낙관 bubble + (2) applyQueuedOverlay 가 만든 queued bubble = 2개를 보여준다.
 */
function clearWorkerSlotsOnStop(reason: string) {
    const active = getActiveWorkers().length;
    if (active === 0 && !hasPendingWorkerReplays()) return;
    clearAllWorkers();
    console.log(`[jaw:stop] cleared worker registry (active=${active}, reason=${reason})`);
}

export function killActiveAgent(reason = 'user') {
    const hadTimer = !!retryPendingTimer;
    const cancelledPendingMain = cancelPendingMainSpawn ? (cancelPendingMainSpawn(reason), true) : false;
    clearRetryTimer(false);  // stop 의도: 큐 재개 안 함
    // Fix A: 사용자 stop은 큐도 폐기. steer/internal kill은 큐 보존.
    // Fix C2: worker registry 도 비워서 hasBlockingWorkers/hasPendingWorkerReplays가 즉시 false.
    if (reason === 'api' || reason === 'user') {
        purgeQueueOnStop(reason);
        clearWorkerSlotsOnStop(reason);
    }
    if (!activeProcess) return hadTimer || cancelledPendingMain;  // timer/gated spawn 취소도 "killed" 취급
    console.log(`[jaw:kill] reason=${reason}`);
    if (activeProcess.pid) killReasons.set(activeProcess.pid, reason);
    try { activeProcess.kill('SIGTERM'); } catch (e: unknown) { console.warn('[agent:kill] SIGTERM failed', { pid: activeProcess?.pid, error: (e as Error).message }); }
    const proc = activeProcess;
    setTimeout(() => {
        try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch (e: unknown) { console.warn('[agent:kill] SIGKILL failed', { pid: proc?.pid, error: (e as Error).message }); }
    }, 2000);
    // Fix C1: 사용자 stop 시 isAgentBusy()가 즉시 false가 되도록 참조를 동기 해제.
    // 실제 child 종료는 위 setTimeout SIGKILL이 백그라운드에서 마무리.
    // exit handler의 setActiveProcess(null) / activeProcesses.delete 는 idempotent.
    if (reason === 'api' || reason === 'user') {
        activeProcess = null;
    }
    return true;
}

export function killAllAgents(reason = 'user') {
    const hadTimer = !!retryPendingTimer;
    const cancelledPendingMain = cancelPendingMainSpawn ? (cancelPendingMainSpawn(reason), true) : false;
    clearRetryTimer(false);  // stop 의도: 큐 재개 안 함
    // Fix A: 사용자 stop은 큐도 폐기. Fix C2: worker 슬롯도 비움.
    if (reason === 'api' || reason === 'user') {
        purgeQueueOnStop(reason);
        clearWorkerSlotsOnStop(reason);
    }
    let killed = 0;
    for (const [id, proc] of activeProcesses) {
        console.log(`[jaw:killAll] killing ${id}, reason=${reason}`);
        if (proc.pid) killReasons.set(proc.pid, reason);
        try {
            if (proc.pid) {
                killProcessTree(proc.pid, 'SIGTERM');
            } else {
                proc.kill('SIGTERM');
            }
            killed++;
        } catch (e: unknown) { console.warn(`[agent:killAll] SIGTERM failed for ${id}`, (e as Error).message); }
        const ref = proc;
        setTimeout(() => {
            try {
                if (ref && !ref.killed) {
                    if (ref.pid) {
                        killProcessTree(ref.pid, 'SIGKILL');
                    } else {
                        ref.kill('SIGKILL');
                    }
                }
            } catch { /* already dead */ }
            ref.stdin?.destroy();
            ref.stdout?.destroy();
            ref.stderr?.destroy();
        }, 2000);
    }
    // Also kill main activeProcess if not in map
    if (activeProcess && !activeProcesses.has('main')) {
        killActiveAgent(reason);
    }
    // Fix C1: 사용자 stop 시 isAgentBusy() 즉시 false. 실제 종료는 백그라운드 SIGKILL.
    if (reason === 'api' || reason === 'user') {
        activeProcess = null;
        activeProcesses.clear();
    }
    return killed > 0 || !!activeProcess || hadTimer || cancelledPendingMain;
}

export function waitForProcessEnd(timeoutMs = 3000) {
    if (!activeProcess) return Promise.resolve();
    return new Promise<void>(resolve => {
        const check = setInterval(() => {
            if (!activeProcess) { clearInterval(check); resolve(); }
        }, 100);
        setTimeout(() => { clearInterval(check); resolve(); }, timeoutMs);
    });
}

export async function steerAgent(newPrompt: string, source: string) {
    const wasRunning = killActiveAgent('steer');
    if (wasRunning) await waitForProcessEnd(3000);
    insertMessage.run('user', newPrompt, source, '', settings.workingDir || null);
    broadcast('new_message', { role: 'user', content: newPrompt, source });
    const { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } = await import('../orchestrator/pipeline.js');
    const origin = source || 'web';
    const task = isResetIntent(newPrompt)
        ? orchestrateReset({ origin, _skipInsert: true })
        : isContinueIntent(newPrompt)
            ? orchestrateContinue({ origin, _skipInsert: true })
            : orchestrate(newPrompt, { origin, _skipInsert: true });
    task.catch((err: Error) => {
        console.error('[steer:orchestrate]', err.message);
        broadcast('orchestrate_done', { text: `[error] ${err.message}`, error: true, origin });
    });
}

// ─── Message Queue ───────────────────────────────────

export function getQueuedMessageSnapshotForScope(scope: string): Array<{
    id: string;
    prompt: string;
    source: RuntimeOrigin;
    ts: number;
}> {
    return messageQueue
        .filter(item => item.scope === scope)
        .map(item => ({
            id: item.id,
            prompt: item.prompt,
            source: item.source,
            ts: item.ts,
        }));
}

export function removeQueuedMessage(id: string): { removed: QueueItem | null; pending: number } {
    const idx = messageQueue.findIndex(item => item.id === id);
    if (idx === -1) return { removed: null, pending: messageQueue.length };
    const [removed] = messageQueue.splice(idx, 1);
    try { deleteQueuedMessage.run(id); } catch (err) {
        console.warn(`[queue] DB delete failed for ${id}:`, (err as Error).message);
    }
    console.log(`[queue] -1 (${messageQueue.length} pending) removed=${id}`);
    broadcast('queue_update', { pending: messageQueue.length });
    return { removed: removed!, pending: messageQueue.length };
}

export function enqueueMessage(prompt: string, source: RuntimeOrigin, meta?: { target?: RemoteTarget; chatId?: string | number; requestId?: string; scope?: string }): string {
    const item: QueueItem = {
        id: crypto.randomUUID(),
        prompt,
        source,
        scope: meta?.scope || 'default',
        target: meta?.target,
        chatId: meta?.chatId,
        requestId: meta?.requestId,
        ts: Date.now(),
    };
    insertQueuedMessage.run(item.id, JSON.stringify(item));
    messageQueue.push(item);
    console.log(`[queue] +1 (${messageQueue.length} pending)`);
    broadcast('queue_update', { pending: messageQueue.length });
    processQueue();
    return item.id;
}

export async function processQueue() {
    if (queueProcessing) return;

    // Auto-drain pending worker replays when Boss is idle. Covers the case where
    // Boss died after the dispatch client disconnected — the result was stuck in
    // pendingReplay and nothing was triggering drainPendingReplays. Dynamic
    // import avoids circular dep (pipeline.ts imports from this module).
    if (!activeProcess && !retryPendingTimer && !mainSpawnStarting && !hasBlockingWorkers() && hasPendingWorkerReplays()) {
        queueMicrotask(() => {
            import('../orchestrator/pipeline.js')
                .then(({ drainPendingReplays }) => drainPendingReplays({ origin: 'system' }))
                .catch(err => console.error('[processQueue:drain]', (err as Error).message));
        });
        // Fall through: if messageQueue has entries, we still process them below.
        // orchestrate() inside drain will also drain — idempotent via claimWorkerReplay.
    }

    if (
        activeProcess
        || retryPendingTimer
        || mainSpawnStarting
        || hasBlockingWorkers()
        || messageQueue.length === 0
    ) return;
    // NOTE: hasPendingWorkerReplays() is intentionally NOT gated here —
    // orchestrate() drains pending replays at entry (pipeline.ts drainPendingReplays),
    // so the queued user message still arrives AFTER the worker result. Keeping this
    // gate caused a deadlock (see devlog/_plan/260417_message_duplication/02_*).
    queueProcessing = true;

    // Group by source+target — only process the first group, leave rest in queue
    const first = messageQueue[0]!;
    const groupKey = groupQueueKey(first.source, first.target);
    const batch: QueueItem[] = [];
    const remaining: QueueItem[] = [];

    for (const m of messageQueue) {
        const key = groupQueueKey(m.source, m.target);
        if (key === groupKey) batch.push(m);
        else remaining.push(m);
    }

    // Replace queue with remaining items + unprocessed batch tail
    // 📋 Queue policy: "fair" — 다른 chatId 메시지 우선 소비, 같은 chatId tail은 뒤로.
    //    "chatId-first" 정책이 필요하면 push 순서를 (batch.slice(1), ...remaining)으로 변경.
    messageQueue.length = 0;
    if (batch.length > 1) {
        // 🔑 batch 분리: 첫 메시지만 처리
        // remaining(다른 chatId) 먼저 → batch tail(같은 chatId) 뒤 → chatId 독점 방지
        messageQueue.push(...remaining, ...batch.slice(1));
    } else {
        messageQueue.push(...remaining);
    }

    const item = batch[0]!;
    const combined = item.prompt;
    const source = item.source;
    const target = item.target;
    const chatId = item.chatId;
    const requestId = item.requestId;
    const origin: RuntimeOrigin = source || 'web';
    console.log(`[queue] processing 1/${batch.length} message(s) for ${groupKey}, ${messageQueue.length} remaining`);

    let inserted = false;
    try {
        insertMessage.run('user', combined, source, '', settings.workingDir || null);
        deleteQueuedMessage.run(item.id);
        inserted = true;
        // Broadcast WITH fromQueue=true so the web client renders the user bubble
        // now (not at enqueue time). gateway.ts:130 also broadcasts at enqueue,
        // but the web client ignores that one — it only acts on fromQueue.
        broadcast('new_message', { role: 'user', content: combined, source, fromQueue: true });
        broadcast('queue_update', { pending: messageQueue.length });

        const { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } = await import('../orchestrator/pipeline.js');
        const task = isResetIntent(combined)
            ? orchestrateReset({ origin, target, chatId, requestId, _skipInsert: true })
            : isContinueIntent(combined)
                ? orchestrateContinue({ origin, target, chatId, requestId, _skipInsert: true })
                : orchestrate(combined, { origin, target, chatId, requestId, _skipInsert: true });

        try {
            await task;
        } catch (err: unknown) {
            const msg = (err as Error).message;
            console.error('[queue:orchestrate]', msg);
            broadcast('orchestrate_done', { text: `[error] ${msg}`, error: true, origin, chatId, target, requestId });
        }
    } catch (setupErr) {
        console.error('[queue:setup]', setupErr);
        if (!inserted) {
            // insertMessage hasn't run yet — safe to requeue
            messageQueue.unshift(item);
        } else {
            // Message is already in DB — broadcast error, don't requeue (would cause duplicate)
            broadcast('orchestrate_done', { text: `[error] setup failed: ${(setupErr as Error).message}`, error: true, origin, chatId, target, requestId });
        }
    } finally {
        queueProcessing = false;
        queueMicrotask(() => processQueue());
    }
}

// ─── Helpers ─────────────────────────────────────────

function makeCleanEnv(extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDE_CODE_SSE_PORT;
    delete env.GEMINI_SYSTEM_MD;
    // Phase 8: strip boss-only dispatch token from employee spawns so employees
    // cannot authenticate against /api/orchestrate/dispatch even via localhost.
    // Detect employee spawn by the explicit JAW_EMPLOYEE_MODE flag; main spawns
    // pass an empty extraEnv and keep the token inherited from process.env.
    if (extraEnv.JAW_EMPLOYEE_MODE === '1') {
        delete env.JAW_BOSS_TOKEN;
    }
    env.PATH = buildServicePath(env.PATH || '');
    return {
        ...env,
        ...extraEnv,
        PATH: buildServicePath(extraEnv.PATH || env.PATH || ''),
    } as NodeJS.ProcessEnv;
}

function buildHistoryBlock(currentPrompt: string, workingDir?: string | null, maxSessions = 10, maxTotalChars = 8000) {
    const recent = getRecentMessages.all(workingDir || null, Math.max(1, maxSessions * 2)) as RecentMessageRow[];
    if (!recent.length) return '';

    const promptText = String(currentPrompt || '').trim();
    let skipCurrentPromptBudget = 2;
    const blocks = [];
    let charCount = 0;

    for (let i = 0; i < recent.length; i++) {
        const row = recent[i];
        if (!row) continue;
        const role = String(row.role || '');
        const content = String(row.content || '').trim();

        // Exclude the just-inserted current prompt when caller path stores user text
        // before spawn (e.g. steer/telegram/queue paths).
        if (promptText && i < 3 && skipCurrentPromptBudget > 0 && role === 'user' && content === promptText) {
            skipCurrentPromptBudget--;
            continue;
        }

        if (isCompactMarkerRow(row)) {
            const summary = String(row.trace || '').trim();
            if (summary && charCount + summary.length <= maxTotalChars) {
                blocks.push(summary);
            }
            break;
        }

        let entry: string;
        if (content) {
            entry = `[${role || 'user'}] ${content}`;
        } else if (role === 'assistant' && row.trace) {
            entry = `[assistant trace] ${String(row.trace).slice(0, 2000)}`;
        } else {
            entry = '';
        }
        if (!entry) continue;
        if (charCount + entry.length > maxTotalChars) break;
        blocks.push(entry);
        charCount += entry.length;
    }

    if (!blocks.length) return '';
    return `[Recent Context]\n${blocks.reverse().join('\n\n')}`;
}

function withHistoryPrompt(prompt: string, historyBlock: string) {
    const body = String(prompt || '');
    if (!historyBlock) return body;
    return `${historyBlock}\n\n---\n[Current Message]\n${body}`;
}

import { buildArgs, buildResumeArgs, resolveSessionBucket } from './args.js';
export { buildArgs, buildResumeArgs, resolveSessionBucket };

// ─── Upload wrapper ──────────────────────────────────

export const saveUpload = (buffer: Buffer | Uint8Array, originalName: string, options?: SaveUploadOptions) =>
    _saveUpload(UPLOADS_DIR, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), originalName, options);
export { buildMediaPrompt, buildMediaPromptMany };

// ─── Spawn Agent ─────────────────────────────────────

import { AcpClient } from '../cli/acp-client.js';

// ─── ACP Heartbeat Helper ────────────────────────────
// Pure function for conditional heartbeat gating.
// "visible" = WebUI + Telegram common baseline. 💭 is WebUI-only
// (bot.ts:337 hides it), so it's NOT counted as visible.
const DEFAULT_HEARTBEAT_GATE_MS = 20_000;

export function shouldEmitHeartbeat(
    lastVisibleTs: number,
    heartbeatSent: boolean,
    gateMs: number = DEFAULT_HEARTBEAT_GATE_MS,
    now: number = Date.now(),
): boolean {
    if (heartbeatSent) return false;
    return (now - lastVisibleTs) > gateMs;
}

export function shouldResumeBucketSession(
    cli: string,
    requestedModel: string,
    bucketModel: string | null | undefined,
    requestedResumeKey?: string | null,
    bucketResumeKey?: string | null,
): boolean {
    if (cli === 'copilot' && bucketModel) {
        return normalizeModelForCli(cli, requestedModel) === normalizeModelForCli(cli, bucketModel);
    }
    if (cli === 'opencode' && requestedResumeKey) {
        return requestedResumeKey === (bucketResumeKey ?? null);
    }
    return true;
}

export interface SpawnLifecycle {
    onActivity?: (source: string) => void;
    onExit?: (code: number | null) => void;
}

interface SpawnOpts {
    internal?: boolean;
    _isFallback?: boolean;
    _isRetry?: boolean;      // 429 delay retry 중 여부
    _isSmokeContinuation?: boolean;  // Auto-retry after smoke response detected
    _skipInsert?: boolean;
    forceNew?: boolean;
    agentId?: string;
    sysPrompt?: string;
    origin?: string;
    target?: string;
    requestId?: string;
    employeeSessionId?: string;
    chatId?: string | number;
    cli?: string;
    model?: string;
    effort?: string;
    permissions?: string;
    memorySnapshot?: string;
    workspaceContext?: string;
    env?: Record<string, string>;
    lifecycle?: SpawnLifecycle;
    _settingsGateWaited?: boolean;
    _heartbeatAnchorId?: number;
}

type SpawnResult = {
    child: ChildProcess | null;
    promise: Promise<SpawnPromiseResult>;
};

function cleanupEmployeeTmpDir(cwd: string, workingDir: string, label: string) {
    if (cwd !== workingDir) {
        try { fs.rmSync(cwd, { recursive: true, force: true }); }
        catch (e) { console.warn(`[jaw:${label}] tmp cleanup failed:`, (e as Error).message); }
    }
}

export function spawnAgent(prompt: string, opts: SpawnOpts = {}): SpawnResult {
    const { forceNew = false, agentId, sysPrompt: customSysPrompt, memorySnapshot } = opts;
    const origin = opts.origin || 'web';
    const empSid = opts.employeeSessionId || null;
    const mainManaged = !forceNew && !empSid;
    const gateEligibleMain = mainManaged && !opts.agentId && !opts.internal && !opts._isFallback && !opts._isSmokeContinuation;
    const isEmployee = !mainManaged;
    const empTag = isEmployee ? { isEmployee: true } : {};

    if (gateEligibleMain && !opts._settingsGateWaited && isRuntimeSettingsMutationInFlight()) {
        if (activeProcess || retryPendingTimer || mainSpawnStarting) {
            console.log('[jaw] Agent already running, skipping');
            return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
        }
        mainSpawnStarting = true;
        let cancelled = false;
        let cancelReason = 'user';
        const cancelThisSpawn = (reason: string) => {
            cancelled = true;
            cancelReason = reason;
        };
        cancelPendingMainSpawn = cancelThisSpawn;
        const promise: Promise<SpawnPromiseResult> = (async () => {
            try {
                await waitForRuntimeSettingsIdle();
                if (cancelled) {
                    return { text: `⏹️ [${cancelReason}]`, code: -1 };
                }
                const next: SpawnResult = spawnAgent(prompt, { ...opts, _settingsGateWaited: true });
                return await next.promise;
            } finally {
                if (cancelPendingMainSpawn === cancelThisSpawn) cancelPendingMainSpawn = null;
                mainSpawnStarting = false;
                processQueue();
            }
        })();
        return { child: null, promise };
    }

    // Ensure AGENTS.md on disk is fresh before CLI reads it
    // Skip for employee spawns — distribute.ts manages AGENTS.md isolation
    if (!opts.internal && !opts._isFallback && !opts.agentId) regenerateB();

    const liveScope = resolveOrcScope({ origin, chatId: opts.chatId, workingDir: settings.workingDir || null });
    // Employee must not pollute boss's liveRun (see devlog 260423_employee_liverun_contamination)
    const effectiveLiveScope = mainManaged ? liveScope : null;

    // INVARIANT: 모든 외부 호출은 gateway.ts isAgentBusy()를 거침.
    // 직접 spawnAgent 호출 시 retryPendingTimer도 확인할 것.
    if ((activeProcess || (mainSpawnStarting && gateEligibleMain && !opts._settingsGateWaited)) && mainManaged) {
        console.log('[jaw] Agent already running, skipping');
        return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
    }

    // Capture Boss main session channel so disconnected worker results can be
    // replayed to the correct origin/chatId later. Cleared in lifecycle-handler.
    if (mainManaged) {
        setCurrentMainMeta({
            origin,
            target: opts.target,
            chatId: opts.chatId,
            requestId: opts.requestId,
            scopeId: liveScope,
        });
    }

    let resolve: (value: SpawnPromiseResult) => void;
    const resultPromise = new Promise<SpawnPromiseResult>(r => { resolve = r; });

    const session = (getSession() as SessionRow | undefined) ?? {};
    const ownerGeneration = getSessionOwnershipGeneration();
    let cli = resolveMainCli(opts.cli, settings, session);

    // Phase 52: Bootstrap consumption is moved BELOW the bucket-aware `isResume`
    // computation so we can use the authoritative per-bucket resume decision
    // instead of the legacy `isResumeGuess` heuristic. See comment near line 762.

    // ─── Fallback retry: skip to fallback if retries exhausted ───
    if (!opts._isFallback && !opts.internal) {
        const st = fallbackState.get(cli);
        if (st && st.retriesLeft <= 0) {
            const fbAvail = detectCli(st.fallbackCli)?.available;
            if (fbAvail) {
                console.log(`[jaw:fallback] ${cli} retries exhausted → direct ${st.fallbackCli}`);
                broadcast('agent_fallback', { from: cli, to: st.fallbackCli, reason: 'retries exhausted', ...empTag }, isEmployee ? 'internal' : 'public');
                return spawnAgent(prompt, {
                    ...opts, cli: st.fallbackCli, _isFallback: true, _skipInsert: true,
                });
            }
        }
    }

    const permissions = opts.permissions || settings.permissions || session.permissions || 'auto';
    if (cli === 'opencode') {
        ensureOpencodeAlwaysAllowPermissions();
    }
    const cfg = settings.perCli?.[cli] || {};
    const ao = settings.activeOverrides?.[cli] || {};
    const model = opts.model || ao.model || cfg.model || 'default';
    const effort = opts.effort || ao.effort || cfg.effort || '';

    const sysPrompt = customSysPrompt !== undefined
        ? customSysPrompt
        : getSystemPrompt({ currentPrompt: prompt, forDisk: false, memorySnapshot, activeCli: cli });

    // Bucket-aware resume: codex-spark is kept in its own session bucket so
    // cross-model resume (gpt-5.4 ↔ gpt-5.3-codex-spark) doesn't send a
    // mismatched session_id to the server.
    const currentBucket = resolveSessionBucket(cli, model);
    const cliEnv = applyCliEnvDefaults(cli, opts.env);
    const spawnEnv = makeCleanEnv(cliEnv);
    const bucketRow = currentBucket ? getSessionBucket.get(currentBucket) as SessionBucketRow | undefined : null;
    const bucketSessionId = bucketRow?.session_id || null;
    const bucketModel = typeof bucketRow?.model === 'string' ? bucketRow.model : null;
    const bucketResumeKey = typeof bucketRow?.resume_key === 'string' ? bucketRow.resume_key : null;
    const resumeKey = buildSessionResumeKey(cli, spawnEnv);
    const canResumeBucketSession = !bucketSessionId || shouldResumeBucketSession(
        cli,
        model,
        bucketModel,
        resumeKey,
        bucketResumeKey,
    );
    const isResume = empSid
        ? true
        : (!forceNew && !!bucketSessionId && canResumeBucketSession);

    // ─── Bootstrap compact 1-shot injection (Phase 52: bucket-aware) ───
    // Vendor-agnostic: compact handler reset session_id and stored bootstrap in DB.
    // Inject only on fresh main spawns (not employee/fallback/internal/resume).
    // Using `isResume` (bucket-aware) instead of legacy `isResumeGuess` so cross-model
    // toggles (e.g. gpt-5.4 ↔ gpt-5.3-codex-spark) get the bootstrap they need.
    if (!opts.agentId && !opts._isFallback && !opts.internal && !isResume) {
        const pending = consumePendingBootstrapPrompt();
        if (pending) {
            console.log(`[jaw:compact] injecting bootstrap (${pending.length} chars)`);
            prompt = `${pending}\n\n---\n\n${prompt}`;
        }
    }

    if (!empSid && !forceNew && bucketSessionId && !canResumeBucketSession) {
        if (cli === 'opencode' && resumeKey !== (bucketResumeKey ?? null)) {
            console.log(`[jaw:resume] ${cli} resume key changed ${bucketResumeKey ?? 'none'} → ${resumeKey}; starting fresh session`);
        } else {
            console.log(`[jaw:resume] ${cli} model changed ${bucketModel} → ${model}; starting fresh session`);
        }
    }

    // ─── User prompt wrapper (boss main only) ───
    // #99: compact timestamp (moved from builder.ts system prompt → user prompt)
    // + memory search nudge
    if (!opts.agentId && !opts.internal && !opts._isSmokeContinuation) {
        const _d = new Date(); const _p = (n: number) => String(n).padStart(2, '0');
        const _h = _d.getHours(); const _h12 = _h % 12 || 12;
        const ts = `${_p(_d.getFullYear() % 100)}${_p(_d.getMonth() + 1)}${_p(_d.getDate())}-${_p(_h12)}:${_p(_d.getMinutes())}${_h < 12 ? 'AM' : 'PM'}.`;
        prompt = `${ts}\n${prompt}\n(need history? cli-jaw memory search "<keywords>" in "ENGLISH")`;
    }

    const resumeSessionId = empSid || (isResume ? bucketSessionId : null);
    const historyBlock = !isResume ? buildHistoryBlock(prompt, settings.workingDir) : '';
    const promptForArgs = (cli === 'gemini' || cli === 'opencode')
        ? withHistoryPrompt(prompt, historyBlock)
        : prompt;
    let args;
    if (isResume) {
        const sid = resumeSessionId || '';
        console.log(`[jaw:resume] ${cli} session=${sid.slice(0, 12)}...`);
        args = buildResumeArgs(cli, model, effort, sid, prompt, permissions, { fastMode: cfg.fastMode, sysPrompt });
    } else {
        args = buildArgs(cli, model, effort, promptForArgs, sysPrompt, permissions, { fastMode: cfg.fastMode });
    }

    const agentLabel = agentId || 'main';

    // ─── Universal employee isolation ────────────────────
    // All CLIs auto-read AGENTS.md/CLAUDE.md/GEMINI.md from cwd.
    // Employees must NOT see the Boss's instruction files.
    let spawnCwd = settings.workingDir;

    if (opts.agentId && (customSysPrompt || sysPrompt)) {
        const empPrompt = customSysPrompt || sysPrompt;
        const empPromptWithWorkspace = opts.workspaceContext
            ? `${opts.workspaceContext}\n\n${empPrompt}`
            : empPrompt;
        const tmpDir = join(os.tmpdir(), `jaw-emp-${agentLabel}-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md']) {
            fs.writeFileSync(join(tmpDir, name), empPromptWithWorkspace);
        }
        const dotClaudeDir = join(tmpDir, '.claude');
        fs.mkdirSync(dotClaudeDir, { recursive: true });
        fs.writeFileSync(join(dotClaudeDir, 'CLAUDE.md'), empPromptWithWorkspace);
        try {
            fs.symlinkSync(settings.workingDir, join(tmpDir, 'workspace'), 'dir');
        } catch {
            // Non-fatal: the absolute Project root in Workspace Context remains authoritative.
        }

        spawnCwd = tmpDir;
        console.log(`[jaw:${agentLabel}] Employee isolated → ${tmpDir}`);
    }

    // ─── DIFF-A: Preflight — verify CLI binary exists before spawn ───
    const detected = detectCli(cli);
    const resolvedOpencodeBinary = cli === 'opencode'
        ? resolveOpencodeBinary(spawnEnv, '')
        : '';
    const cliAvailable = cli === 'opencode'
        ? detected.available || !!resolvedOpencodeBinary
        : detected.available;
    if (!cliAvailable) {
        const msg = `CLI '${cli}' not found in PATH. Run \`jaw doctor --json\`.`;
        console.error(`[jaw:${agentLabel}] ${msg}`);
        if (mainManaged) clearLiveRun(liveScope);
        broadcast('agent_done', { text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
        resolve!({ text: '', code: 127 });
        if (mainManaged) processQueue();
        cleanupEmployeeTmpDir(spawnCwd, settings.workingDir, agentLabel);
        return { child: null, promise: resultPromise };
    }

    if (cli === 'copilot') {
        console.log(`[jaw:${agentLabel}] Spawning: copilot --acp --model ${model} [${permissions}]`);
    } else {
        console.log(`[jaw:${agentLabel}] Spawning: ${cli} ${args.join(' ').slice(0, 120)}...`);
    }

    if (cli === 'gemini' && sysPrompt) {
        const tmpSysFile = join(os.tmpdir(), `jaw-gemini-sys-${agentLabel}.md`);
        fs.writeFileSync(tmpSysFile, sysPrompt);
        spawnEnv.GEMINI_SYSTEM_MD = tmpSysFile;
    }

    // ─── Copilot ACP branch ──────────────────────
    if (cli === 'copilot') {
        // Write model + reasoning_effort to ~/.copilot/config.json (CLI flags unsupported)
        try {
            const cfgPath = join(os.homedir(), '.copilot', 'config.json');
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            let changed = false;

            // Sync model
            if (model && model !== 'default') {
                if (cfg.model !== model) { cfg.model = model; changed = true; }
            }

            // Sync effort
            if (effort) {
                if (cfg.reasoning_effort !== effort) { cfg.reasoning_effort = effort; changed = true; }
            } else if (cfg.reasoning_effort) {
                delete cfg.reasoning_effort; changed = true;
            }

            if (changed) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        } catch (e: unknown) { console.warn('[jaw:copilot] config.json sync failed:', (e as Error).message); }

        const acp = new AcpClient({ model, workDir: spawnCwd, permissions, env: spawnEnv });
        acp.spawn();
        const child = acp.proc;
        if (!child) {
            throw new Error('Copilot ACP process was not created');
        }
        if (mainManaged) activeProcess = child;
        // Phase 7-3: detect duplicate spawn for same agentLabel. claimWorker guards
        // the route, but log here as a last-chance diagnostic if something slips past.
        if (activeProcesses.has(agentLabel)) {
            console.warn(`[spawn:dup] activeProcesses already has child for ${agentLabel} — orphaning previous reference`);
        }
        activeProcesses.set(agentLabel, child);
        if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...empTag });
        if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);

        // ─── DIFF-C: ACP error guard — prevent uncaught EventEmitter crash ───
        let acpSettled = false;  // guard: error→exit can fire sequentially
        acp.on('error', (err: Error) => {
            if (acpSettled) return;
            acpSettled = true;
            cleanupEmployeeTmpDir(spawnCwd, settings.workingDir, agentLabel);
            opts.lifecycle?.onExit?.(null);
            const msg = `Copilot ACP spawn failed: ${err.message}`;
            console.error(`[acp:error] ${msg}`);
            activeProcesses.delete(agentLabel);
            if (mainManaged) {
                activeProcess = null;
                clearLiveRun(liveScope);
                broadcast('agent_status', { running: false, agentId: agentLabel });
            }
            broadcast('agent_done', { text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
            resolve!({ text: '', code: 1 });
            if (mainManaged) processQueue();
        });

        if (mainManaged && !opts.internal && !opts._skipInsert) {
            insertMessage.run('user', prompt, cli, model, settings.workingDir || null);
        }
        broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag });

        const ctx: CopilotSpawnContext = {
            fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set<string>(),
            hasClaudeStreamEvents: false, sessionId: null as string | null, cost: null as number | null,
            turns: null as number | null, duration: null as number | null, tokens: null, stderrBuf: '',
            thinkingBuf: '',
            liveScope: effectiveLiveScope,
            parentLiveScope: isEmployee ? liveScope : null,
        };

        // Flush accumulated 💭 thinking buffer as a single merged event
        function flushThinking() {
            if (!ctx.thinkingBuf) return;
            const merged = ctx.thinkingBuf.trim();
            if (merged) {
                const singleLine = merged.replace(/\s+/g, ' ').trim();
                const label = singleLine.length > 120 ? `${singleLine.slice(0, 119)}…` : singleLine;
                console.log(`  💭 ${label}`);
                const tool = { icon: '💭', label, toolType: 'thinking' as const, detail: merged };
                ctx.toolLog.push(tool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                if (ctx.parentLiveScope) appendLiveRunTool(ctx.parentLiveScope, { ...tool, isEmployee: true });
                broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag });
            }
            ctx.thinkingBuf = '';
        }

        // session/update → broadcast mapping
        let replayMode = false;  // Phase 17.2: suppress events during loadSession replay
        let lastVisibleBroadcastTs = Date.now();
        let heartbeatSent = false;

        acp.on('session/update', (params) => {
            if (replayMode) return;  // 리플레이 중 모든 이벤트 무시
            const parsed = extractFromAcpUpdate(params, ctx);
            if (!parsed) return;

            if (parsed.tool) {
                const parsedTool = parsed.tool;
                // Buffer 💭 thought chunks → flush when different event arrives
                if (parsedTool.icon === '💭') {
                    ctx.thinkingBuf += parsedTool.detail || parsedTool.label;
                    return;
                }
                // Non-💭 tool → flush any pending thinking first
                flushThinking();
                // [I3] Include stepRef + status in dedupe key to allow repeated same-name tool calls
                const key = `${parsedTool.icon}:${parsedTool.label}:${parsedTool.stepRef || ''}:${parsedTool.status || ''}`;
                if (!ctx.seenToolKeys.has(key)) {
                    ctx.seenToolKeys.add(key);
                    ctx.toolLog.push(parsedTool);
                    if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                    if (ctx.parentLiveScope) appendLiveRunTool(ctx.parentLiveScope, { ...parsedTool, isEmployee: true });
                    broadcast('agent_tool', { agentId: agentLabel, ...parsedTool, ...empTag });
                    // Reset heartbeat gate on actually visible broadcast (not 💭)
                    lastVisibleBroadcastTs = Date.now();
                    heartbeatSent = false;
                }
            }
            if (parsed.text) {
                flushThinking();
                ctx.fullText += parsed.text;
                if (ctx.liveScope) appendLiveRunText(ctx.liveScope, parsed.text);
                // text-only updates are local accumulation, not visible to user — no gate reset
            }
            opts.lifecycle?.onActivity?.('acp');
        });

        // [P2-3.14] session/cancelled → route through extractFromAcpUpdate for UI notification
        acp.on('session/cancelled', (params: Record<string, unknown>) => {
            const parsed = extractFromAcpUpdate({
                update: { sessionUpdate: 'session_cancelled', ...(params || {}) },
            });
            if (parsed?.tool) {
                ctx.toolLog.push(parsed.tool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                if (ctx.parentLiveScope) appendLiveRunTool(ctx.parentLiveScope, { ...parsed.tool, isEmployee: true });
                broadcast('agent_tool', { agentId: agentLabel, ...parsed.tool, ...empTag });
            }
        });

        // [P2-3.15] session/request_permission → audit record in toolLog
        acp.on('session/request_permission', (params: Record<string, unknown>) => {
            const parsed = extractFromAcpUpdate({
                update: { sessionUpdate: 'request_permission', ...(params || {}) },
            });
            if (parsed?.tool) {
                ctx.toolLog.push(parsed.tool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                if (ctx.parentLiveScope) appendLiveRunTool(ctx.parentLiveScope, { ...parsed.tool, isEmployee: true });
                broadcast('agent_tool', { agentId: agentLabel, ...parsed.tool, ...empTag });
            }
        });

        // stderr_activity → stderrBuf accumulation + conditional heartbeat
        acp.on('stderr_activity', (text: string) => {
            // Accumulate stderr for diagnostics (capped)
            if (ctx.stderrBuf.length < 4000) {
                ctx.stderrBuf += text + '\n';
            }
            opts.lifecycle?.onActivity?.('stderr');
            // Conditional heartbeat: visible progress absent for N seconds
            if (shouldEmitHeartbeat(lastVisibleBroadcastTs, heartbeatSent)) {
                heartbeatSent = true;
                const elapsed = Math.round((Date.now() - lastVisibleBroadcastTs) / 1000);
                console.log(`  ⏳ agent active (no visible event for ${elapsed}s)`);
                broadcast('agent_tool', {
                    agentId: agentLabel,
                    icon: '⏳',
                    label: 'working... (no visible progress)',
                    ...empTag,
                });
            }
        });

        // Run ACP flow
        let promptCompleted = false;
        (async () => {
            try {
                const initResult = await acp.initialize();
                if (process.env.DEBUG) console.log('[acp:init]', JSON.stringify(initResult).slice(0, 200));

                replayMode = true;  // Phase 17.2: mute during session load
                let loadSessionOk = false;
                if (isResume && resumeSessionId) {
                    try {
                        await acp.loadSession(resumeSessionId);
                        loadSessionOk = true;
                        console.log(`[acp:session] loadSession OK: ${resumeSessionId.slice(0, 12)}...`);
                    } catch (loadErr: unknown) {
                        console.warn(`[acp:session] loadSession FAILED: ${(loadErr as Error).message} — falling back to createSession`);
                        if (empSid && opts.agentId) {
                            clearEmployeeSession.run(opts.agentId);
                            console.warn(`[acp:session] cleared stale employee resume for ${opts.agentId}`);
                        }
                        await acp.createSession(spawnCwd);
                    }
                } else {
                    await acp.createSession(spawnCwd);
                }
                replayMode = false;  // Phase 17.2: unmute after session load
                ctx.sessionId = acp.sessionId;

                // Reset accumulated text from loadSession replay (ACP replays full history)
                ctx.fullText = '';
                ctx.toolLog = [];
                ctx.seenToolKeys.clear();
                ctx.thinkingBuf = '';  // Phase 17.2: clear replay thinking too
                if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);

                // If loadSession failed (or not resuming), inject history into prompt
                const needsHistoryFallback = isResume && !loadSessionOk;
                const fallbackHistory = needsHistoryFallback ? buildHistoryBlock(prompt, settings.workingDir) : '';
                const acpPrompt = needsHistoryFallback
                    ? withHistoryPrompt(prompt, fallbackHistory)
                    : (isResume ? prompt : withHistoryPrompt(prompt, historyBlock));
                const { promise: promptPromise } = acp.prompt(acpPrompt);
                const promptResult = await promptPromise;
                promptCompleted = true;
                if (process.env.DEBUG) console.log('[acp:prompt:result]', JSON.stringify(promptResult).slice(0, 200));

                // Save session BEFORE shutdown — acp.shutdown() causes SIGTERM (code=null),
                // which skips the exit handler's code===0 gate, losing session continuity.
                const persistedAcpSessionId = ctx.sessionId;
                if (persistedAcpSessionId && persistMainSession({
                    ownerGeneration,
                    forceNew,
                    employeeSessionId: empSid,
                    sessionId: persistedAcpSessionId,
                    isFallback: opts._isFallback,
                    cli,
                    model,
                    resumeKey,
                    effort: cfg.effort || '',
                })) {
                    console.log(`[jaw:session] saved ${cli} session=${persistedAcpSessionId.slice(0, 12)}... (pre-shutdown)`);
                }

                await acp.shutdown();
            } catch (err: unknown) {
                console.error(`[acp:error] ${(err as Error).message}`);
                ctx.stderrBuf += (err as Error).message;
                acp.kill();
            }
        })();

        acp.on('exit', ({ code, signal }) => {
            if (acpSettled) return;  // error handler already resolved
            acpSettled = true;
            cleanupEmployeeTmpDir(spawnCwd, settings.workingDir, agentLabel);
            opts.lifecycle?.onExit?.(code ?? null);
            // [I2] Consume per-process kill reason
            const acpKillReason = consumeKillReason(acp.proc?.pid);
            if (code !== 0 && !acpKillReason) {
                console.warn(`[acp:unexpected-exit] code=${code} signal=${signal} sessionId=${ctx.sessionId || 'none'}`);
            }
            const wasKilled = !!acpKillReason;
            const wasSteer = acpKillReason === 'steer';
            flushThinking();  // Flush any remaining thinking buffer

            const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, code, cli);
            const acpCode = promptCompleted ? 0 : (code ?? 1);

            // Delegated to lifecycle-handler.ts → handleAgentExit:
            //   - smoke continuation (guarded by !wasSteer)
            //   - output: ⏹️ [interrupted] prefix (wasSteer && mainManaged && !opts.internal)
            //   - error: code !== 0 && !wasKilled → classifyExitError
            //   - trace: if (traceText) traceText = `⏹️ [interrupted]…`
            handleAgentExit({
                ctx, code: acpCode, cli, model, agentLabel, mainManaged, origin,
                resumeKey,
                prompt, opts, cfg, ownerGeneration, forceNew, empSid,
                isResume, wasKilled, wasSteer, smokeResult,
                effortDefault: '', costLine: '',
                resolve: resolve!,
                activeProcesses,
                setActiveProcess: (v) => { activeProcess = v; },
                retryState: {
                    timer: retryPendingTimer,
                    resolve: retryPendingResolve,
                    origin: retryPendingOrigin,
                    setTimer: (t) => { retryPendingTimer = t; },
                    setResolve: (r) => { retryPendingResolve = r; },
                    setOrigin: (o) => { retryPendingOrigin = o; },
                    setIsEmployee: (v) => { retryPendingIsEmployee = v; },
                },
                fallbackState,
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue,
            }).catch((err: Error) => {
                console.error('[jaw:lifecycle] handleAgentExit failed (ACP):', err.message);
            });
        });

        return { child, promise: resultPromise };
    }

    // ─── Standard CLI branch (claude/codex/gemini/opencode) ──────
    // DIFF-B: Windows needs shell:true to resolve .cmd shims (npm global installs)
    const spawnCommand = cli === 'opencode' && process.platform !== 'win32'
        ? (resolvedOpencodeBinary || detected.path || cli)
        : (process.platform === 'win32' ? cli : (detected.path || cli));
    const opencodeSpawnAudit = cli === 'opencode'
        ? buildOpencodeSpawnAudit({ args, cwd: spawnCwd, env: spawnEnv, binary: spawnCommand })
        : undefined;
    if (opencodeSpawnAudit) {
        console.log(`[jaw:opencode:audit] ${JSON.stringify(opencodeSpawnAudit)}`);
    }
    const child = spawn(spawnCommand, args, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? { shell: true } : {}),
    });
    if (mainManaged) activeProcess = child;
    // Phase 7-3: detect duplicate spawn for same agentLabel.
    if (activeProcesses.has(agentLabel)) {
        console.warn(`[spawn:dup] activeProcesses already has child for ${agentLabel} — orphaning previous reference`);
    }
    activeProcesses.set(agentLabel, child);
    if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...empTag });
    if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);

    // ─── DIFF-A: error guard — prevent uncaught ENOENT crash ───
    let stdSettled = false;  // guard: error→close can fire sequentially
    let lastOpencodeIoAt = Date.now();
    let opencodeIdleTimer: ReturnType<typeof setInterval> | null = null;
    const clearOpencodeIdleTimer = () => {
        if (!opencodeIdleTimer) return;
        clearInterval(opencodeIdleTimer);
        opencodeIdleTimer = null;
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
        clearOpencodeIdleTimer();
        if (stdSettled) return;
        stdSettled = true;
        cleanupEmployeeTmpDir(spawnCwd, settings.workingDir, agentLabel);
        opts.lifecycle?.onExit?.(null);
        const msg = err.code === 'ENOENT'
            ? `CLI '${cli}' 실행 실패 (ENOENT). 설치/경로를 확인하세요.`
            : `CLI '${cli}' 실행 실패: ${err.message}`;
        console.error(`[jaw:${agentLabel}:error] ${msg}`);
        activeProcesses.delete(agentLabel);
        if (mainManaged) {
            activeProcess = null;
            clearLiveRun(liveScope);
            broadcast('agent_status', { running: false, agentId: agentLabel });
        }
        broadcast('agent_done', { text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
        resolve!({ text: '', code: 127 });
        if (mainManaged) processQueue();
    });

    if (mainManaged && !opts.internal && !opts._skipInsert) {
        insertMessage.run('user', prompt, cli, model, settings.workingDir || null);
    }

    if (cli === 'claude') {
        child.stdin.write(withHistoryPrompt(prompt, historyBlock));
    } else if (cli === 'codex' && !isResume) {
        const codexStdin = historyBlock
            ? `${historyBlock}\n\n[User Message]\n${prompt}`
            : `[User Message]\n${prompt}`;
        child.stdin.write(codexStdin);
    }
    child.stdin.end();

    broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag });

    const ctx: SpawnContext = {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        sessionId: null as string | null,
        cost: null as number | null,
        turns: null as number | null,
        duration: null as number | null,
        tokens: null,
        stderrBuf: '',
        hasActiveSubAgent: false,
        showReasoning: settings.showReasoning === true,
        outputTextStarted: false,
        liveScope: effectiveLiveScope,
        parentLiveScope: isEmployee ? liveScope : null,
        geminiResultSeen: false,
        opencodeSpawnAudit: opencodeSpawnAudit as Record<string, unknown> | undefined,
    };
    let geminiWatchdog: ReturnType<typeof setTimeout> | null = null;
    let buffer = '';
    const recordOpencodeEvent = (line: string, event: CliEventRecord) => {
        if (cli !== 'opencode') return;
        ctx.opencodeRawEvents = pushOpencodeRawEvent(ctx.opencodeRawEvents, line);
        ctx.opencodeLastEventType = typeof event?.type === 'string' ? event.type : 'unknown';
        ctx.opencodeLastEventAt = Date.now();
    };
    const dispatchNdjsonLine = (line: string): void => {
        let raw: unknown;
        try {
            raw = JSON.parse(line);
        } catch {
            return;
        }
        const event = discriminate(cli, raw);
        if (!event) {
            const type = fieldString(asCliEventRecord(raw).type, '<no-type>');
            ctx.traceLog.push(`[cli:unknown-event] cli=${cli} type=${type} preview=${JSON.stringify(raw).slice(0, 200)}`);
            return;
        }
        recordOpencodeEvent(line, event);
        if (process.env.DEBUG) {
            console.log(`[jaw:event:${agentLabel}] ${cli} type=${event.type}`);
            console.log(`[jaw:raw:${agentLabel}] ${line.slice(0, 300)}`);
        }
        logEventSummary(agentLabel, cli, event, ctx);
        if (!ctx.sessionId) ctx.sessionId = extractSessionId(cli, event);
        extractFromEvent(cli, event, ctx, agentLabel, empTag);
        // Gemini watchdog: AFTER extractFromEvent sets geminiResultSeen
        if (cli === 'gemini' && ctx.geminiResultSeen && !geminiWatchdog) {
            geminiWatchdog = setTimeout(() => {
                console.warn(`[jaw:gemini-watchdog] ${agentLabel} — result seen but close not received after 10s, killing`);
                try { child.kill('SIGTERM'); } catch { /* already dead */ }
            }, 10000);
        }
        // Sub-agent wait: keep stall timer alive
        if (ctx.hasActiveSubAgent) {
            opts.lifecycle?.onActivity?.('heartbeat');
        }
        const outputChunk = extractOutputChunk(cli, event, ctx);
        if (outputChunk) {
            if (ctx.liveScope) appendLiveRunText(ctx.liveScope, outputChunk);
            broadcast('agent_output', {
                agentId: agentLabel,
                cli,
                text: outputChunk,
                ...empTag,
            }, isEmployee ? 'internal' : 'public');
        }
    };
    if (cli === 'opencode') {
        opencodeIdleTimer = setInterval(() => {
            const idleMs = Date.now() - lastOpencodeIoAt;
            if (idleMs < 60_000) return;
            const snapshot = buildOpencodeRuntimeSnapshot(ctx);
            const line = `[jaw:opencode:idle] ${idleMs}ms ${JSON.stringify(snapshot)}`;
            console.warn(line);
            ctx.traceLog.push(line);
        }, 30_000);
    }

    child.stdout.on('data', (chunk) => {
        opts.lifecycle?.onActivity?.('stdout');
        lastOpencodeIoAt = Date.now();
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            dispatchNdjsonLine(line);
        }
    });

    child.stderr.on('data', (chunk) => {
        opts.lifecycle?.onActivity?.('stderr');
        lastOpencodeIoAt = Date.now();
        const text = chunk.toString().trim();
        console.error(`[jaw:stderr:${agentLabel}] ${text}`);
        ctx.stderrBuf += text + '\n';
    });

    child.on('close', (code) => {
        clearOpencodeIdleTimer();
        if (geminiWatchdog) { clearTimeout(geminiWatchdog); geminiWatchdog = null; }
        if (stdSettled) return;  // error handler already resolved
        // [I1] Flush residual NDJSON buffer — last event may lack trailing newline
        if (buffer.trim()) {
            dispatchNdjsonLine(buffer);
            buffer = '';
        }
        flushClaudeBuffers(ctx, agentLabel, empTag);  // flush any pending thinking/input buffers
        cleanupEmployeeTmpDir(spawnCwd, settings.workingDir, agentLabel);
        opts.lifecycle?.onExit?.(code ?? null);

        // [I2] Consume per-process kill reason
        const stdKillReason = consumeKillReason(child.pid);
        const wasKilled = !!stdKillReason;
        const wasSteer = stdKillReason === 'steer';

        const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, code, cli);

        // Build cost display line (CLI-only feature)
        const costParts = [];
        if (ctx.cost != null) costParts.push(`$${Number(ctx.cost).toFixed(4)}`);
        if (ctx.turns) costParts.push(`${ctx.turns}턴`);
        if (ctx.duration) costParts.push(`${(ctx.duration / 1000).toFixed(1)}s`);
        const costLine = costParts.length ? `\n\n✅ ${costParts.join(' · ')}` : '';

        // Delegated to lifecycle-handler.ts → handleAgentExit:
        //   - smoke continuation (guarded by !wasSteer)
        //   - output: ⏹️ [interrupted] prefix (wasSteer && mainManaged && !opts.internal)
        //   - error: code !== 0 && !wasKilled → classifyExitError
        //   - trace: if (traceText) traceText = `⏹️ [interrupted]…`
        handleAgentExit({
            ctx, code, cli, model, agentLabel, mainManaged, origin,
            resumeKey,
            prompt, opts, cfg, ownerGeneration, forceNew, empSid,
            isResume, wasKilled, wasSteer, smokeResult,
            effortDefault: 'medium', costLine,
            resolve: resolve!,
            activeProcesses,
            setActiveProcess: (v) => { activeProcess = v; },
            retryState: {
                timer: retryPendingTimer,
                resolve: retryPendingResolve,
                origin: retryPendingOrigin,
                setTimer: (t) => { retryPendingTimer = t; },
                setResolve: (r) => { retryPendingResolve = r; },
                setOrigin: (o) => { retryPendingOrigin = o; },
                setIsEmployee: (v) => { retryPendingIsEmployee = v; },
            },
            fallbackState,
            fallbackMaxRetries: FALLBACK_MAX_RETRIES,
            processQueue,
        }).catch((err: Error) => {
            console.error('[jaw:lifecycle] handleAgentExit failed (CLI):', err.message);
        });
    });

    return { child, promise: resultPromise };
}

// ─── Forward References ──────────────────────────────
// Set after spawnAgent is defined to avoid circular deps
setSpawnAgent(spawnAgent);
setMainMetaHandler(setCurrentMainMeta);
setMemorySpawnRef(spawnAgent, activeProcesses);
