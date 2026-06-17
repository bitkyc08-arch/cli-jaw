// ─── Agent Spawn + Kill/Steer/Queue ──────────────────

import fs from 'fs';
import os from 'os';
import crypto from 'node:crypto';
import { join } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'node:string_decoder';
import { broadcast } from '../core/bus.js';
import { publish as ssePublish } from '../core/event-bus.js';
import { settings, UPLOADS_DIR, detectCli, getProjectDirs } from '../core/config.js';
import { migrateLegacyClaudeValue } from '../cli/claude-models.js';
import { stripUndefined } from '../core/strip-undefined.js';
import {
    clearEmployeeSession, getSession, insertMessage, insertMessageWithTraceRun, getRecentMessages,
    listQueuedMessages, insertQueuedMessage, deleteQueuedMessage,
    getSessionBucket, clearSessionBucket, setSessionBucketSnapshot,
} from '../core/db.js';
import { sanitizeToolLogForDurableStorage } from '../shared/tool-log-sanitize.js';
import { buildTaskSnapshot } from '../memory/runtime.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { getSystemPrompt, regenerateB } from '../prompt/builder.js';
import { extractSessionId, extractFromEvent, extractFromAcpUpdate, extractOutputChunk, logEventSummary, flushClaudeBuffers, flushOpenCodeBuffers } from './events.js';
import { detectSmokeResponse } from './smoke-detector.js';
import { saveUpload as _saveUpload, buildMediaPrompt, buildMediaPromptMany, type SaveUploadOptions } from '../../lib/upload.js';
import { resolveMainCli, consumePendingBootstrapPrompt } from '../core/main-session.js';
import {
    getSessionOwnershipGeneration,
    persistMainSession,
} from './session-persistence.js';
import { isCompactMarkerRow } from '../core/compact.js';
import { isRuntimeSettingsMutationInFlight, waitForRuntimeSettingsIdle } from '../core/runtime-settings-gate.js';
import { hasBlockingWorkers, hasPendingWorkerReplays, getActiveWorkers, clearAllWorkers } from '../orchestrator/worker-registry.js';
import { sanitizeWorkerProgressTools } from '../orchestrator/worker-progress.js';
import { handleAgentExit, setSpawnAgent, setMainMetaHandler } from './lifecycle-handler.js';
import { buildServicePath } from '../core/runtime-path.js';
import { resolveOrcScope } from '../orchestrator/scope.js';
import { stripInterviewTracker } from '../orchestrator/sanitize.js';
import { beginLiveRun, appendLiveRunText, setLiveRunTraceId, clearLiveRun, replaceLiveRunTools, appendLiveRunTool, getLiveRun } from './live-run-state.js';
import {
    memoryFlushCounter as _memoryFlushCounter,
    flushCycleCount as _flushCycleCount,
    setSpawnRef as setMemorySpawnRef,
} from './memory-flush-controller.js';
import { applyCliEnvDefaults, buildSessionResumeKey, ensureOpencodeAlwaysAllowPermissions } from './spawn-env.js';
import { attachWatchdog, DEFAULT_WATCHDOG_ABSOLUTE_HARD_CAP_MS } from './watchdog.js';
import {
    buildOpencodeRuntimeSnapshot,
    buildOpencodeSpawnAudit,
    pushOpencodeRawEvent,
    resolveOpencodeBinary,
} from './opencode-diagnostics.js';
import type { SpawnContext, ToolEntry } from '../types/agent.js';
import { asCliEventRecord, discriminate, fieldString, type CliEventRecord } from '../types/cli-events.js';
import { isJawRuntimeEvent, handleJawRuntimeEvent } from './claude-e-runtime.js';
import { jawRuntime } from './jwc-runtime.js';
import { appendTraceEvent, stampTraceTool, startTraceRun } from '../trace/store.js';
import {
    AGY_COMPLETE_KILL_REASON,
    extractAgyConversationId,
    formatAgyTimeoutMessage,
    getAgyQuietCompletionDelayMs,
    isAgyStaleSessionOutput,
    normalizeAgyCloseText,
    stripAgyPromptEchoPrefix,
    stripAgyResumeReplayPrefix,
    stripAgyResumeReplayPrefixes,
} from './agy-runtime.js';
import { startAgyTranscriptWatcher, type AgyTranscriptWatcherHandle } from './agy-transcript-watcher.js';
import { appendAssistantTextSegment, normalizeAssistantDisplayText, pushTrace } from './events/helpers.js';
import { listKiroConversationIdsForCwd } from './kiro-auth.js';
import {
    captureKiroSessionIdAfterExit,
    finalizeKiroFullText,
    flushKiroStdoutContext,
    isKiroPlainTextCli,
    isKiroStaleSessionOutput,
    parseAiESessionIdFromStderr,
    processKiroStdoutChunk,
    type KiroStreamEvent,
} from './kiro-runtime.js';
import { resolveCursorModelVariant } from './cursor-runtime.js';
import { normalizePiSettings, spawnPiRpc } from './pi-runtime.js';
import { getEmployeeMcpServers } from './mcp-passthrough.js';

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
    cli?: string;
    model?: string;
    effectiveProvider?: string;
}
let currentMainMeta: MainSessionMeta | null = null;
export function getCurrentMainMeta(): MainSessionMeta | null {
    return currentMainMeta;
}
export function setCurrentMainMeta(meta: MainSessionMeta | null): void {
    currentMainMeta = meta;
}

export function buildAiERuntimeStatusMeta(cli: string, provider: string, model: string): Record<string, unknown> {
    if (cli !== 'ai-e') return {};
    const mode = 'pty';
    return {
        selector: 'ai-e',
        provider,
        effectiveProvider: provider,
        model,
        mode,
        runtime: {
            cli,
            selector: 'ai-e',
            provider,
            model,
            mode,
        },
    };
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
    cli?: string;
    trace?: string;
}

interface SessionBucketRow {
    session_id?: string | null;
    model?: string | null;
    resume_key?: string | null;
    output_len?: number | null;
    memory_snapshot?: string | null;
    updated_at?: string | number | null;
}

type SpawnPromiseResult = { text: string; code: number };

interface CopilotSpawnContext extends SpawnContext {
    thinkingBuf: string;
}

import { killProcessTree } from './spawn/process-kill.js';

/** Single choke point for streamed assistant text: appends to the live-run
 *  accumulator and broadcasts agent_output tagged with the owning trace run
 *  id plus the cumulative text length (`textLen`). The web UI uses the pair
 *  as a replay-dedup cursor — SSE reconnect replays re-deliver chunks the
 *  client already rendered (devlog 260612 manager_stream_hidden_state_audit
 *  06-08). */
function broadcastAgentOutput(
    ctx: SpawnContext,
    agentLabel: string,
    cli: string,
    text: string,
    empTag: Record<string, unknown>,
    audience: 'public' | 'internal',
): void {
    const textLen = ctx.liveScope ? appendLiveRunText(ctx.liveScope, text) : null;
    broadcast('agent_output', {
        agentId: agentLabel,
        cli,
        text,
        ...(ctx.traceRunId ? { traceRunId: ctx.traceRunId } : {}),
        ...(textLen !== null ? { textLen } : {}),
        ...empTag,
    }, audience);
}

function appendParentLiveRunTool(ctx: SpawnContext, tool: ToolEntry): void {
    if (!ctx.parentLiveScope) return;
    const [safeTool] = sanitizeWorkerProgressTools([{ ...tool, isEmployee: true }]);
    if (!safeTool) return;
    appendLiveRunTool(ctx.parentLiveScope, { ...safeTool, isEmployee: true });
    // 260613 20 P2-i: employee runs are internal-audience, so without this the
    // web UI paints employee progress only on interaction-triggered snapshot
    // hydration. Surface the SAME sanitized mirror entry on the SSE bus only —
    // ssePublish (not broadcast) so internal listeners are not notified twice;
    // the call sites already broadcast the raw tool internally.
    ssePublish('agent', 'agent_tool', { ...safeTool, isEmployee: true });
}

function emitKiroStreamEvents(
    events: KiroStreamEvent[],
    ctx: SpawnContext,
    agentLabel: string,
    cli: string,
    empTag: Record<string, unknown>,
    traceAudience: 'public' | 'internal',
): void {
    for (const event of events) {
        ctx.kiroLastVisibleAt = Date.now();
        ctx.kiroHeartbeatSent = false;
        ctx.stallWatchdog?.markProgress();
        if (event.kind === 'assistant_delta') {
            const segment = normalizeAssistantDisplayText(event.text);
            if (!segment) continue;
            if (ctx.liveOutputText !== undefined) {
                ctx.liveOutputText += segment;
            }
            ctx.outputTextStarted = true;
            broadcastAgentOutput(ctx, agentLabel, cli, segment, empTag, traceAudience);
            continue;
        }
        const tool: ToolEntry = {
            icon: event.icon,
            label: event.label,
            detail: event.detail || '',
            stepRef: event.stepRef,
            status: event.status,
            toolType: 'tool',
        };
        stampTraceTool(tool, ctx, 'tool');
        const existingIdx = ctx.toolLog.findIndex((entry) => entry.stepRef === event.stepRef);
        if (existingIdx >= 0) {
            ctx.toolLog[existingIdx] = { ...ctx.toolLog[existingIdx], ...tool };
        } else {
            ctx.toolLog.push(tool);
        }
        if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
        appendParentLiveRunTool(ctx, tool);
        broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag }, traceAudience);
    }
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

const queueCtrl = createQueueController({
    isSpawnBusy: () => Boolean(activeProcess) || mainSpawnStarting || steerInProgress || queueCtrl.isRetryPending(),
    hasBlockingWorkers,
    hasPendingWorkerReplays,
    insertMessage,
    getActiveChatSession,
    insertQueuedMessage,
    deleteQueuedMessage,
    listQueuedMessages: listQueuedMessages as unknown as { all(): Array<{ id: string; payload: string }> },
    broadcast,
    importPipeline: () => import('../orchestrator/pipeline.js'),
    getWorkingDir: () => settings["workingDir"] || null,
});

export const {
    messageQueue,
    enqueueMessage,
    removeQueuedMessage,
    processQueue,
    setQueueHold,
    clearQueueHold,
    getQueueHoldId,
    clearRetryTimer,
    resetFallbackState,
    getFallbackState,
    getQueuedMessageSnapshotForScope,
} = queueCtrl;

let mainSpawnStarting = false;
let cancelPendingMainSpawn: ((reason: string) => void) | null = null;
let steerInProgress = false;

export function setSteerInProgress(v: boolean): void {
    const was = steerInProgress;
    steerInProgress = v;
    if (was && !v) queueMicrotask(() => processQueue());
}

export function isSteerInProgress(): boolean {
    return steerInProgress;
}

export function isAgentBusy(): boolean {
    // jwc in-process turns hold no ChildProcess, so activeProcess stays null —
    // fold the resident runtime's own busy flag in (110.3 §D).
    return !!activeProcess || jawRuntime.busy || queueCtrl.isRetryPending() || mainSpawnStarting || steerInProgress;
}

// ─── Kill / Steer ────────────────────────────────────

// [I2] Per-process kill reason map (replaces global variable to avoid cross-process confusion)
const killReasons = new Map<number, string>();
const DEFAULT_STEER_WAIT_MS = 3_000;
const DEFAULT_KILL_ESCALATION_MS = 2_000;
const CLAUDE_E_STEER_WAIT_MS = 30_000;
const CLAUDE_E_STEER_KILL_ESCALATION_MS = 8_000;

function getActiveMainCli(): string | null {
    return typeof currentMainMeta?.cli === 'string' ? currentMainMeta.cli : null;
}

function isActiveAiEPtyRuntime(): boolean {
    const cli = getActiveMainCli();
    return cli === 'claude-e' || cli === 'ai-e';
}

function getKillPolicy(reason: string): { signal: NodeJS.Signals; escalationMs: number } {
    if (reason === 'steer' && isActiveAiEPtyRuntime()) {
        return { signal: 'SIGINT', escalationMs: CLAUDE_E_STEER_KILL_ESCALATION_MS };
    }
    return { signal: 'SIGTERM', escalationMs: DEFAULT_KILL_ESCALATION_MS };
}

export function getSteerWaitMsForActiveAgent(): number {
    return isActiveAiEPtyRuntime() ? CLAUDE_E_STEER_WAIT_MS : DEFAULT_STEER_WAIT_MS;
}

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

function clearMainLiveRunOnStop(reason: string): void {
    if (reason !== 'api' && reason !== 'user' && reason !== 'steer') return;
    const scope = currentMainMeta?.scopeId || resolveOrcScope(stripUndefined({
        origin: currentMainMeta?.origin || 'web',
        chatId: currentMainMeta?.chatId,
        workingDir: settings["workingDir"] || null,
    }));
    clearLiveRun(scope);
}

export function killActiveAgent(reason = 'user') {
    const hadTimer = queueCtrl.isRetryPending();
    const cancelledPendingMain = cancelPendingMainSpawn ? (cancelPendingMainSpawn(reason), true) : false;
    clearRetryTimer(false);  // stop 의도: 큐 재개 안 함
    clearMainLiveRunOnStop(reason);
    // Fix A: 사용자 stop은 큐도 폐기. steer/internal kill은 큐 보존.
    // Fix C2: worker registry 도 비워서 hasBlockingWorkers/hasPendingWorkerReplays가 즉시 false.
    if (reason === 'api' || reason === 'user') {
        queueCtrl.purgeQueueOnStop(reason);
        clearWorkerSlotsOnStop(reason);
    }
    if (!activeProcess) return hadTimer || cancelledPendingMain;  // timer/gated spawn 취소도 "killed" 취급
    const policy = getKillPolicy(reason);
    console.log(`[jaw:kill] reason=${reason} cli=${getActiveMainCli() || 'unknown'} signal=${policy.signal} escalationMs=${policy.escalationMs}`);
    if (activeProcess.pid) killReasons.set(activeProcess.pid, reason);
    try {
        if (activeProcess.pid) {
            killProcessTree(activeProcess.pid, policy.signal);
        } else {
            activeProcess.kill(policy.signal);
        }
    } catch (e: unknown) { console.warn(`[agent:kill] ${policy.signal} failed`, { pid: activeProcess?.pid, error: (e as Error).message }); }
    const proc = activeProcess;
    // Immediately sever stdio to stop late output from reaching broadcast handlers
    proc.stdout?.removeAllListeners('data');
    proc.stderr?.removeAllListeners('data');
    setTimeout(() => {
        try {
            if (proc && !proc.killed) {
                if (proc.pid) killProcessTree(proc.pid, 'SIGKILL');
                else proc.kill('SIGKILL');
            }
        } catch (e: unknown) { console.warn('[agent:kill] SIGKILL failed', { pid: proc?.pid, error: (e as Error).message }); }
        proc.stdin?.destroy();
        proc.stdout?.destroy();
        proc.stderr?.destroy();
    }, policy.escalationMs);
    // Fix C1: 사용자 stop/steer 시 isAgentBusy()가 즉시 false가 되도록 참조를 동기 해제.
    // 실제 child 종료는 위 setTimeout SIGKILL이 백그라운드에서 마무리.
    // exit handler의 setActiveProcess(null) / activeProcesses.delete 는 idempotent.
    if (reason === 'api' || reason === 'user' || reason === 'steer') {
        activeProcess = null;
    }
    return true;
}

export function killAllAgents(reason = 'user') {
    const hadTimer = queueCtrl.isRetryPending();
    const cancelledPendingMain = cancelPendingMainSpawn ? (cancelPendingMainSpawn(reason), true) : false;
    clearRetryTimer(false);  // stop 의도: 큐 재개 안 함
    clearMainLiveRunOnStop(reason);
    // Fix A: 사용자 stop은 큐도 폐기. Fix C2: worker 슬롯도 비움.
    if (reason === 'api' || reason === 'user') {
        queueCtrl.purgeQueueOnStop(reason);
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
    const steerWaitMs = getSteerWaitMsForActiveAgent();
    const wasRunning = killActiveAgent('steer');
    if (wasRunning) await waitForProcessEnd(steerWaitMs);
    insertMessage.run('user', newPrompt, source, '', settings["workingDir"] || null, getActiveChatSession());
    broadcast('new_message', { role: 'user', content: newPrompt, source });
    broadcast('steer_started', { prompt: newPrompt, origin: source || 'web' });
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


// ─── Helpers ─────────────────────────────────────────

function makeCleanEnv(extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["CLAUDE_CODE_SSE_PORT"];
    delete env["GEMINI_SYSTEM_MD"];
    // Phase 8: strip boss-only dispatch token from employee spawns so employees
    // cannot authenticate against /api/orchestrate/dispatch even via localhost.
    // Detect employee spawn by the explicit JAW_EMPLOYEE_MODE flag; main spawns
    // pass an empty extraEnv and keep the token inherited from process.env.
    if (extraEnv["JAW_EMPLOYEE_MODE"] === '1') {
        delete env["JAW_BOSS_TOKEN"];
    }
    env["PATH"] = buildServicePath(env["PATH"] || '');
    return {
        ...env,
        ...extraEnv,
        PATH: buildServicePath(extraEnv["PATH"] || env["PATH"] || ''),
    } as NodeJS.ProcessEnv;
}

function formatCliUnavailableMessage(cli: string, detected: ReturnType<typeof detectCli>): string {
    const rejected = detected.rejected || [];
    if (rejected.length > 0) {
        const details = rejected
            .slice(0, 3)
            .map((entry) => `${entry.path} (${entry.reason})`)
            .join('; ');
        const suffix = rejected.length > 3 ? `; +${rejected.length - 3} more` : '';
        return `CLI '${cli}' found on PATH but no spawnable executable was available. Rejected: ${details}${suffix}. Run \`jaw doctor --json\`.`;
    }
    return `CLI '${cli}' not found in PATH. Run \`jaw doctor --json\`.`;
}

function buildHistoryBlock(currentPrompt: string, workingDir?: string | null, maxSessions = 10, maxTotalChars = 8000) {
    const recent = getRecentMessages.all(workingDir || null, getActiveChatSession(), Math.max(1, maxSessions * 2)) as RecentMessageRow[];
    if (!recent.length) return '';

    const promptText = String(currentPrompt || '').trim();
    let skipCurrentPromptBudget = 2;
    const blocks = [];
    let charCount = 0;

    for (let i = 0; i < recent.length; i++) {
        const row = recent[i];
        if (!row) continue;
        if (row.cli === 'goal_boundary') break;
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
            if (summary && !isStaleWorklogHistoryArtifact(summary) && charCount + summary.length <= maxTotalChars) {
                blocks.push(summary);
            }
            break;
        }

        let entry: string;
        if (role === 'assistant' && row.trace && !isStaleWorklogHistoryArtifact(String(row.trace))) {
            entry = `[assistant trace] ${String(row.trace).slice(0, 2000)}`;
        } else if (content && !isStaleWorklogHistoryArtifact(content)) {
            entry = `[${role || 'user'}] ${content}`;
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

function isStaleWorklogHistoryArtifact(text: string): boolean {
    const value = String(text || '');
    return [
        'Read the previous worklog and continue any incomplete tasks.',
        '이 워크로그는 스텁이네요',
        '이전 worklog 기준으로 이어서 진행합니다.',
        'Continuing from previous worklog.',
        '前回の worklog から続行しています。',
        '正在从上一个 worklog 继续。',
    ].some(marker => value.includes(marker));
}

const HISTORY_BOUNDARY_INSTRUCTION = [
    '[History Boundary]',
    'Recent Context is read-only background. The Current Message below is the only task to execute now.',
    'Do not continue prior plans, audits, commands, questions, or goals unless the Current Message explicitly asks to resume or continue them.',
].join('\n');

function withHistoryPrompt(prompt: string, historyBlock: string) {
    const body = String(prompt || '');
    if (!historyBlock) return body;
    return `${historyBlock}\n\n${HISTORY_BOUNDARY_INSTRUCTION}\n\n---\n[Current Message]\n${body}`;
}

function getLatestAssistantContentForAgyResume(workingDir?: string | null): string | null {
    const rows = getRecentMessages.all(workingDir || null, getActiveChatSession(), 12) as RecentMessageRow[];
    const row = rows.find((msg) => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0);
    return row?.content || null;
}

function getRecentAssistantContentsForAgyResume(workingDir?: string | null): string[] {
    const rows = getRecentMessages.all(workingDir || null, getActiveChatSession(), 20) as RecentMessageRow[];
    return rows
        .filter((msg) => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0)
        .map((msg) => String(msg.content || '').trim());
}

import { buildArgs, buildResumeArgs, formatAgyPrintTimeout, resolveAiEProvider, resolveSessionBucket } from './args.js';
export { buildArgs, buildResumeArgs, resolveAiEProvider, resolveSessionBucket };

// ─── Upload wrapper ──────────────────────────────────

export const saveUpload = (buffer: Buffer | Uint8Array, originalName: string, options?: SaveUploadOptions) =>
    _saveUpload(UPLOADS_DIR, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), originalName, options);
export { buildMediaPrompt, buildMediaPromptMany };

// ─── Spawn Agent ─────────────────────────────────────

import { AcpClient } from '../cli/acp-client.js';
import { CodexAppClient } from './codex-app-client.js';
import { extractFromCodexAppEvent } from './codex-app-events.js';

import { shouldEmitHeartbeat, shouldResumeBucketSession, GEMINI_RESUME_TTL_MS } from './spawn/resume.js';
export { shouldEmitHeartbeat, shouldResumeBucketSession, GEMINI_RESUME_TTL_MS };
import { createQueueController, FALLBACK_MAX_RETRIES } from './spawn/queue.js';
export type { QueueController } from './spawn/queue.js';

const GEMINI_HISTORY_MAX_SESSIONS = 4;
const GEMINI_HISTORY_MAX_CHARS = 3000;

export interface SpawnLifecycle {
    onActivity?: (source: string) => void;
    onExit?: (code: number | null) => void;
}

interface SpawnOpts {
    internal?: boolean;
    _isFallback?: boolean;
    _retryAttempt?: number;  // 429 exponential backoff attempt counter (0-based)
    _isCapacityFallback?: boolean;
    _isSmokeContinuation?: boolean;  // Auto-retry after smoke response detected
    _isGoalContinuation?: boolean;
    _skipInsert?: boolean;
    _skipHistory?: boolean;
    _skipResume?: boolean;
    _skipSessionPersist?: boolean;
    _employeeFreshSessionRetry?: boolean;
    _kiroFreshRetry?: boolean;
    forceNew?: boolean;
    agentId?: string;
    sysPrompt?: string;
    origin?: string;
    target?: string;
    requestId?: string;
    employeeSessionId?: string;
    employeeOutputLen?: number;
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
    const empSid = opts._skipResume ? null : (opts.employeeSessionId || null);
    const mainManaged = !forceNew && !opts.agentId && !empSid && !opts.internal;
    const gateEligibleMain = mainManaged && !opts.agentId && !opts.internal && !opts._isFallback && !opts._isSmokeContinuation && !opts._isGoalContinuation;
    const isEmployee = !mainManaged;
    const empTag = isEmployee ? { isEmployee: true } : {};

    if (gateEligibleMain && !opts._settingsGateWaited && isRuntimeSettingsMutationInFlight()) {
        if (activeProcess || queueCtrl.isRetryPending() || mainSpawnStarting) {
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

    const liveScope = resolveOrcScope(stripUndefined({ origin, chatId: opts.chatId, workingDir: settings["workingDir"] || null }));
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
        setCurrentMainMeta(stripUndefined({
            origin,
            target: opts.target,
            chatId: opts.chatId,
            requestId: opts.requestId,
            scopeId: liveScope,
        }));
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
        const st = queueCtrl.fallbackState.get(cli);
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

    // ─── jwc in-process branch (110.3 §B) ───────────────────────────────
    // Resident engine, no ChildProcess. Mirrors the main-managed lifecycle
    // (insertMessage → beginLiveRun → run → persist → clearLiveRun → processQueue)
    // so isAgentBusy()/queue/SSE behave identically. Employees fall through.
    if (cli === 'jwc' && mainManaged && !opts.internal) {
        const jwcLabel = 'main';
        const jwcOverrides = settings["activeOverrides"]?.['jwc'] as Record<string, string> | undefined;
        const jwcPerCli = settings["perCli"]?.['jwc'] as Record<string, string> | undefined;
        const jwcModel = jwcOverrides?.['model'] || jwcPerCli?.['model'] || 'claude-fable-5';
        const jwcProvider = jwcPerCli?.['provider'] || 'anthropic';
        const jwcCwd = settings["workingDir"] || process.cwd();
        if (!opts._skipInsert) {
            insertMessage.run('user', prompt, 'jwc', jwcModel, settings["workingDir"] || null, getActiveChatSession());
        }
        mainSpawnStarting = true;
        beginLiveRun(liveScope, 'jwc');
        broadcast('agent_status', { running: true, agentId: jwcLabel, cli: 'jwc' });
        jawRuntime.setModelPattern(jwcProvider !== 'anthropic' ? `${jwcProvider}/${jwcModel}` : jwcModel);
        jawRuntime.setLiveScope(liveScope);
        const settleJwcTurn = (result: { text: string; code: number }): void => {
            const live = getLiveRun(liveScope);
            const finalText = result.code === 0 ? live.text : result.text;
            // Persist may throw (better-sqlite3 is sync: DB lock / schema). Cleanup MUST
            // still run or mainSpawnStarting sticks true and the jwc queue deadlocks.
            try {
                insertMessageWithTraceRun.run(
                    'assistant', finalText, 'jwc', jwcModel, null,
                    JSON.stringify(sanitizeToolLogForDurableStorage(live.toolLog)),
                    settings["workingDir"] || null, live.traceRunId || null, getActiveChatSession(),
                );
                broadcast('agent_done', { text: finalText, origin, ...(result.code === 0 ? {} : { error: true }) });
            } catch (err) {
                console.error('[jwc:persist]', err instanceof Error ? err.message : String(err));
                broadcast('agent_done', { text: finalText, origin, error: true });
            } finally {
                clearLiveRun(liveScope);
                broadcast('agent_status', { running: false, agentId: jwcLabel, cli: 'jwc' });
                mainSpawnStarting = false;
                jawRuntime.setLiveScope(undefined);
                resolve!({ text: finalText, code: result.code });
                processQueue();
            }
        };
        // jawRuntime.prompt is designed never to reject, but guard defensively so a
        // broken turn never leaves the queue wedged or emits an unhandled rejection.
        jawRuntime.prompt(jwcCwd, prompt).then(settleJwcTurn, err => {
            console.error('[jwc:turn]', err instanceof Error ? err.message : String(err));
            settleJwcTurn({ text: `❌ jwc turn failed: ${err instanceof Error ? err.message : String(err)}`, code: 1 });
        });
        return { child: null, promise: resultPromise };
    }

    const permissions = opts.permissions || settings["permissions"] || session.permissions || 'auto';
    if (cli === 'opencode') {
        ensureOpencodeAlwaysAllowPermissions();
    }
    const cfg = settings["perCli"]?.[cli] || {};
    const ao = settings["activeOverrides"]?.[cli] || {};
    const requestedModel = opts.model || ao.model || cfg.model || 'default';
    const effort = opts.effort ?? ao.effort ?? cfg.effort ?? '';
    const effectiveProvider = cli === 'ai-e'
        ? resolveAiEProvider(
            typeof cfg.provider === 'string'
                ? cfg.provider
                : typeof ao.provider === 'string'
                    ? ao.provider
                    : undefined,
            requestedModel,
        )
        : cli;
    const model = cli === 'ai-e' && effectiveProvider === 'claude'
        ? migrateLegacyClaudeValue(requestedModel)
        : requestedModel;
    const runtimeModel = cli === 'cursor' ? resolveCursorModelVariant(model, effort) : model;
    if (mainManaged) {
        setCurrentMainMeta(stripUndefined({
            origin,
            target: opts.target,
            chatId: opts.chatId,
            requestId: opts.requestId,
            scopeId: liveScope,
            cli,
            model: runtimeModel,
            effectiveProvider,
        }));
    }
    const includeDirectories = Array.isArray(cfg.includeDirectories)
        ? cfg.includeDirectories.filter((dir: unknown): dir is string => typeof dir === 'string' && dir.trim().length > 0)
        : [];

    // System prompt is computed AFTER the resume decision below (#prompt-cache):
    // the frozen task snapshot needs `isResume`/`bucketRow` to pick stored bytes.
    // Snapshot input must be the raw prompt before bootstrap/wrapper mutations.
    const promptForSnapshot = prompt;

    // Bucket-aware resume: codex-spark is kept in its own session bucket so
    // cross-model resume (gpt-5.4 ↔ gpt-5.3-codex-spark) doesn't send a
    // mismatched session_id to the server.
    const currentBucket = resolveSessionBucket(cli, runtimeModel, effectiveProvider);
    const envDefaultsCli = cli === 'ai-e' ? effectiveProvider : cli;
    const cliEnv = applyCliEnvDefaults(envDefaultsCli, opts.env);
    const spawnEnv = makeCleanEnv(cliEnv);
    const bucketRow = currentBucket ? getSessionBucket.get(currentBucket) as SessionBucketRow | undefined : null;
    const bucketSessionId = bucketRow?.session_id || null;
    const bucketModel = typeof bucketRow?.model === 'string' ? bucketRow.model : null;
    const bucketResumeKey = typeof bucketRow?.resume_key === 'string' ? bucketRow.resume_key : null;
    const bucketUpdatedAt = bucketRow?.updated_at ?? null;
    const resumeKey = buildSessionResumeKey(cli, spawnEnv);
    // AGY native resume can replay prior stdout and continue stale mid-turn planner
    // state. cli-jaw keeps safer cross-turn context via DB history instead.
    const providerSupportsResume = cli !== 'agy'
        && !(cli === 'ai-e' && effectiveProvider !== 'claude' && effectiveProvider !== 'kiro' && effectiveProvider !== 'codex' && effectiveProvider !== 'grok');
    const canResumeBucketSession = !bucketSessionId || shouldResumeBucketSession(
        cli,
        runtimeModel,
        bucketModel,
        resumeKey,
        bucketResumeKey,
        bucketUpdatedAt,
        Date.now(),
        effectiveProvider,
    );
    const isResume = empSid
        ? true
        : (providerSupportsResume && !opts._skipResume && !forceNew && !!bucketSessionId && canResumeBucketSession);
    const runtimeStatusMeta = buildAiERuntimeStatusMeta(cli, effectiveProvider, runtimeModel);

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
        try {
            if (currentBucket) clearSessionBucket.run(currentBucket);
        } catch (e) {
            console.warn('[jaw:resume] stale bucket clear failed:', (e as Error).message);
        }
        if (cli === 'gemini') {
            console.log(`[jaw:resume] ${cli} stale bucket rejected for model ${bucketModel ?? 'none'} → ${model}; starting fresh session`);
        } else if (cli === 'opencode' && resumeKey !== (bucketResumeKey ?? null)) {
            console.log(`[jaw:resume] ${cli} resume key changed ${bucketResumeKey ?? 'none'} → ${resumeKey}; starting fresh session`);
        } else {
            console.log(`[jaw:resume] ${cli} model changed ${bucketModel} → ${runtimeModel}; starting fresh session`);
        }
    }

    // ─── Frozen task snapshot (#prompt-cache) ────────────
    // Boss-session turns reuse the snapshot stored at the chain's fresh spawn so
    // the system prompt stays byte-identical across resume turns (cache hits).
    // Regenerated only here on fresh spawns; the row (and snapshot) dies on any
    // bucket clear (compact / model change / stale TTL), matching the agreed
    // "fresh spawn + compact" refresh triggers. Explicit opts.memorySnapshot wins.
    let memorySnapshotForPrompt = memorySnapshot;
    if (!opts.agentId && memorySnapshotForPrompt === undefined && customSysPrompt === undefined && currentBucket) {
        const frozen = isResume && typeof bucketRow?.memory_snapshot === 'string' && bucketRow.memory_snapshot
            ? bucketRow.memory_snapshot
            : null;
        if (frozen) {
            memorySnapshotForPrompt = frozen;
        } else {
            try {
                const built = buildTaskSnapshot(promptForSnapshot, 2800) || '';
                if (built) {
                    memorySnapshotForPrompt = built;
                    setSessionBucketSnapshot.run(currentBucket, runtimeModel, built);
                }
            } catch (e) {
                console.warn('[jaw:snapshot] freeze build failed:', (e as Error).message);
            }
        }
    }

    const sysPrompt = customSysPrompt !== undefined
        ? customSysPrompt
        : getSystemPrompt(stripUndefined({ currentPrompt: promptForSnapshot, forDisk: false, memorySnapshot: memorySnapshotForPrompt, activeCli: cli }));

    // ─── User prompt wrapper (boss main only) ───
    // #99: compact timestamp + project root (moved from builder.ts system prompt → user prompt)
    // + memory search nudge (regular messages only)
    if (!opts.agentId && !opts.internal) {
        const _d = new Date(); const _p = (n: number) => String(n).padStart(2, '0');
        const _h = _d.getHours(); const _h12 = _h % 12 || 12;
        const ts = `${_p(_d.getFullYear() % 100)}${_p(_d.getMonth() + 1)}${_p(_d.getDate())}-${_p(_h12)}:${_p(_d.getMinutes())}${_h < 12 ? 'AM' : 'PM'}.`;
        const _projDirs = getProjectDirs();
        const projLine = _projDirs && _projDirs.length > 0
            ? _projDirs.map(d => `Project root: ${d}`).join('\n') + '\n'
            : '';
        const memoryNudge = (!opts._isSmokeContinuation && !opts._isGoalContinuation)
            ? '\n(need history? L1: cli-jaw chat/memory search/context | L2: cli-jaw dashboard memory search, cli-jaw dashboard chat search)'
            : '';
        prompt = `${ts}\n${projLine}${prompt}${memoryNudge}`;
    }

    const resumeSessionId = empSid || (isResume ? bucketSessionId : null);
    const needsHistory = !opts._skipHistory && (!isResume || cli === 'pi');
    const historyBlock = needsHistory
        ? buildHistoryBlock(
            prompt,
            settings["workingDir"],
            cli === 'gemini' ? GEMINI_HISTORY_MAX_SESSIONS : 10,
            cli === 'gemini' ? GEMINI_HISTORY_MAX_CHARS : 8000,
        )
        : '';
    let promptForArgs = (cli === 'agy' || cli === 'cursor' || cli === 'kiro-code' || cli === 'gemini' || cli === 'grok' || cli === 'opencode' || (cli === 'ai-e' && effectiveProvider !== 'claude'))
        ? withHistoryPrompt(prompt, historyBlock)
        : prompt;
    if (cli === 'agy' && sysPrompt) {
        promptForArgs = `[Current cli-jaw task]\n${promptForArgs}\n\n---\n\n[Operational Context — cli-jaw Integration]\nThe following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:\n\n${sysPrompt}`;
    } else if ((cli === 'kiro-code' || (cli === 'ai-e' && effectiveProvider === 'kiro')) && sysPrompt) {
        promptForArgs = `[Operational Context — cli-jaw Integration]\nThe following operational guidelines apply to this session. Follow these task rules and use the tools/commands described:\n\n${sysPrompt}\n\n---\n\n${promptForArgs}`;
    }
    const agyResumeReplayPrefix = cli === 'agy' && isResume
        ? getLatestAssistantContentForAgyResume(settings["workingDir"])
        : null;
    const agyResumeReplayPrefixes = cli === 'agy' && isResume
        ? getRecentAssistantContentsForAgyResume(settings["workingDir"])
        : [];
    const claudeBin = (cli === 'claude-e' || (cli === 'ai-e' && effectiveProvider === 'claude'))
        ? detectCli('claude').path
        : null;
    const agyLogFile = cli === 'agy'
        ? join(os.tmpdir(), `jaw-agy-${agentId || 'main'}-${Date.now()}-${crypto.randomUUID()}.log`)
        : null;
    const rawTimeoutCfg = (settings as Record<string, unknown>)['agentTimeout'];
    const globalTimeoutCfg = rawTimeoutCfg && typeof rawTimeoutCfg === 'object'
        ? rawTimeoutCfg as Record<string, unknown> : {};
    const cliTimeoutCfg = globalTimeoutCfg[cli] && typeof globalTimeoutCfg[cli] === 'object'
        ? globalTimeoutCfg[cli] as Record<string, unknown> : {};
    const mergedTimeoutCfg = { ...globalTimeoutCfg, ...cliTimeoutCfg };
    const resolvedAgyPrintTimeoutMs = typeof mergedTimeoutCfg['absoluteHardCapMs'] === 'number'
        ? mergedTimeoutCfg['absoluteHardCapMs'] as number
        : DEFAULT_WATCHDOG_ABSOLUTE_HARD_CAP_MS;
    const agyPrintTimeout = cli === 'agy'
        ? formatAgyPrintTimeout(resolvedAgyPrintTimeoutMs)
        : undefined;
    const argOptions = {
        fastMode: cfg.fastMode,
        sysPrompt,
        includeDirectories,
        workingDir: settings["workingDir"],
        aiEProvider: effectiveProvider,
        ...(claudeBin ? { claudeBin } : {}),
        ...(agyLogFile ? { agyLogFile } : {}),
        ...(agyPrintTimeout ? { agyPrintTimeout } : {}),
    };
    let args;
    if (isResume) {
        const sid = resumeSessionId || '';
        console.log(`[jaw:resume] ${cli} session=${sid.slice(0, 12)}...`);
        args = buildResumeArgs(cli, runtimeModel, effort, sid, promptForArgs, permissions, argOptions);
    } else {
        args = buildArgs(cli, runtimeModel, effort, promptForArgs, sysPrompt, permissions, argOptions);
    }

    const agentLabel = agentId || 'main';
    const traceAudience: 'public' | 'internal' = (opts.internal || isEmployee) ? 'internal' : 'public';
    const parentLiveScopeForChild = !opts.internal && isEmployee ? liveScope : null;

    // ─── Universal employee isolation ────────────────────
    // All CLIs auto-read AGENTS.md/CLAUDE.md/GEMINI.md from cwd.
    // Employees must NOT see the Boss's instruction files.
    let spawnCwd = settings["workingDir"];

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
            fs.symlinkSync(settings["workingDir"], join(tmpDir, 'workspace'), 'dir');
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
        const msg = formatCliUnavailableMessage(cli, detected);
        console.error(`[jaw:${agentLabel}] ${msg}`);
        if (mainManaged) clearLiveRun(liveScope);
        broadcast('agent_done', { text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
        resolve!({ text: '', code: 127 });
        if (mainManaged) processQueue();
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
        return { child: null, promise: resultPromise };
    }

    if (cli === 'copilot') {
        console.log(`[jaw:${agentLabel}] Spawning: copilot --acp --model ${model} [${permissions}]`);
    } else {
        console.log(`[jaw:${agentLabel}] Spawning: ${cli} ${args.join(' ').slice(0, 120)}...`);
        if (cli === 'claude-e') console.log(`[jaw:${agentLabel}:args] ${JSON.stringify(args)}`);
    }

    if (cli === 'gemini' && sysPrompt) {
        const tmpSysFile = join(os.tmpdir(), `jaw-gemini-sys-${agentLabel}.md`);
        fs.writeFileSync(tmpSysFile, sysPrompt);
        spawnEnv["GEMINI_SYSTEM_MD"] = tmpSysFile;
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
            cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
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
            insertMessage.run('user', prompt, cli, model, settings["workingDir"] || null, getActiveChatSession());
        }
        if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag }, traceAudience);

        const traceRunId = startTraceRun({ cli, model, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience });
        if (mainManaged && !opts.internal) setLiveRunTraceId(liveScope, traceRunId);
        const ctx: CopilotSpawnContext = {
            fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set<string>(),
            hasClaudeStreamEvents: false, sessionId: null as string | null, cost: null as number | null,
            turns: null as number | null, duration: null as number | null, tokens: null, stderrBuf: '',
            thinkingBuf: '',
            liveScope: effectiveLiveScope,
            parentLiveScope: parentLiveScopeForChild,
            traceRunId,
            traceAudience,
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
                stampTraceTool(tool, ctx, 'thinking');
                ctx.toolLog.push(tool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                appendParentLiveRunTool(ctx, tool);
                broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag }, traceAudience);
            }
            ctx.thinkingBuf = '';
        }

        // session/update → broadcast mapping
        let replayMode = false;  // Phase 17.2: suppress events during loadSession replay
        let lastVisibleBroadcastTs = Date.now();
        let heartbeatSent = false;

        acp.on('session/update', (params) => {
            if (replayMode) return;  // 리플레이 중 모든 이벤트 무시
            const update = asCliEventRecord(asCliEventRecord(params)["update"]);
            appendTraceEvent({ runId: ctx.traceRunId, source: 'acp_raw', eventType: fieldString(update.sessionUpdate, 'session/update'), raw: params });
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
                    stampTraceTool(parsedTool, ctx, parsedTool.toolType || 'tool');
                    ctx.toolLog.push(parsedTool);
                    if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                    appendParentLiveRunTool(ctx, parsedTool);
                    broadcast('agent_tool', { agentId: agentLabel, ...parsedTool, ...empTag }, traceAudience);
                    // Reset heartbeat gate on actually visible broadcast (not 💭)
                    lastVisibleBroadcastTs = Date.now();
                    heartbeatSent = false;
                }
            }
            if (parsed.text) {
                flushThinking();
                const segment = appendAssistantTextSegment(ctx, parsed.text);
                if (segment) {
                    broadcastAgentOutput(ctx, agentLabel, cli, segment, empTag, traceAudience);
                    lastVisibleBroadcastTs = Date.now();
                    heartbeatSent = false;
                }
            }
            opts.lifecycle?.onActivity?.('acp');
        });

        // [P2-3.14] session/cancelled → route through extractFromAcpUpdate for UI notification
        acp.on('session/cancelled', (params: Record<string, unknown>) => {
            appendTraceEvent({ runId: ctx.traceRunId, source: 'acp_raw', eventType: 'session/cancelled', raw: params });
            const parsed = extractFromAcpUpdate({
                update: { sessionUpdate: 'session_cancelled', ...(params || {}) },
            });
            if (parsed?.tool) {
                stampTraceTool(parsed.tool, ctx, parsed.tool.toolType || 'tool');
                ctx.toolLog.push(parsed.tool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                appendParentLiveRunTool(ctx, parsed.tool);
                broadcast('agent_tool', { agentId: agentLabel, ...parsed.tool, ...empTag }, traceAudience);
            }
        });

        // [P2-3.15] session/request_permission → audit record in toolLog
        acp.on('session/request_permission', (params: Record<string, unknown>) => {
            appendTraceEvent({ runId: ctx.traceRunId, source: 'acp_raw', eventType: 'session/request_permission', raw: params });
            const parsed = extractFromAcpUpdate({
                update: { sessionUpdate: 'request_permission', ...(params || {}) },
            });
            if (parsed?.tool) {
                stampTraceTool(parsed.tool, ctx, parsed.tool.toolType || 'tool');
                ctx.toolLog.push(parsed.tool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                appendParentLiveRunTool(ctx, parsed.tool);
                broadcast('agent_tool', { agentId: agentLabel, ...parsed.tool, ...empTag }, traceAudience);
            }
        });

        // stderr_activity → stderrBuf accumulation + conditional heartbeat
        acp.on('stderr_activity', (text: string) => {
            appendTraceEvent({ runId: ctx.traceRunId, source: 'stderr', eventType: 'stderr_activity', raw: text });
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
                }, traceAudience);
            }
        });

        // Run ACP flow
        let promptCompleted = false;
        (async () => {
            try {
                const initResult = await acp.initialize();
                if (process.env["DEBUG"]) console.log('[acp:init]', JSON.stringify(initResult).slice(0, 200));

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
                        await acp.createSession(spawnCwd, getEmployeeMcpServers());
                    }
                } else {
                    await acp.createSession(spawnCwd, getEmployeeMcpServers());
                }
                replayMode = false;  // Phase 17.2: unmute after session load
                ctx.sessionId = acp.sessionId;

                // Reset accumulated text from loadSession replay (ACP replays full history)
                ctx.fullText = '';
                ctx.toolLog = [];
                ctx.seenToolKeys.clear();
                ctx.thinkingBuf = '';  // Phase 17.2: clear replay thinking too
                if (mainManaged && !opts.internal) {
                    beginLiveRun(liveScope, cli);
                    if (ctx.traceRunId) setLiveRunTraceId(liveScope, ctx.traceRunId);
                }

                // If loadSession failed (or not resuming), inject history into prompt
                const needsHistoryFallback = isResume && !loadSessionOk;
                const fallbackHistory = needsHistoryFallback && !opts._skipHistory ? buildHistoryBlock(prompt, settings["workingDir"]) : '';
                const acpPrompt = needsHistoryFallback
                    ? withHistoryPrompt(prompt, fallbackHistory)
                    : (isResume ? prompt : withHistoryPrompt(prompt, historyBlock));
                const { promise: promptPromise } = acp.prompt(acpPrompt);
                const promptResult = await promptPromise;
                promptCompleted = true;
                if (process.env["DEBUG"]) console.log('[acp:prompt:result]', JSON.stringify(promptResult).slice(0, 200));

                // Save session BEFORE shutdown — acp.shutdown() causes SIGTERM (code=null),
                // which skips the exit handler's code===0 gate, losing session continuity.
                const persistedAcpSessionId = ctx.sessionId;
                if (persistedAcpSessionId && persistMainSession(stripUndefined({
                    ownerGeneration,
                    forceNew,
                    employeeSessionId: empSid,
                    sessionId: persistedAcpSessionId,
                    isFallback: opts._isFallback,
                    cli,
                    model,
                    resumeKey,
                    effort: cfg.effort || '',
                    skipSessionPersist: opts._skipSessionPersist === true,
                }))) {
                    console.log(`[jaw:session] saved ${cli} session=${persistedAcpSessionId.slice(0, 12)}... (pre-shutdown)`);
                }

                await acp.shutdown();
            } catch (err: unknown) {
                console.error(`[acp:error] ${(err as Error).message}`);
                if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += (err as Error).message;
                acp.kill();
            }
        })();

        acp.on('exit', ({ code, signal }) => {
            if (acpSettled) return;  // error handler already resolved
            acpSettled = true;
            cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
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
                retryState: queueCtrl.retryState,
                fallbackState: queueCtrl.fallbackState,
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue,
            }).catch((err: Error) => {
                console.error('[jaw:lifecycle] handleAgentExit failed (ACP):', err.message);
            });
        });

        return { child, promise: resultPromise };
    }

    // ─── Pi RPC branch ─────────────────────────────
    if (cli === 'pi') {
        const pi = normalizePiSettings(settings["pi"]);
        const profileId = cfg.provider || pi.defaultProfileId;
        const profile = pi.profiles.find((entry) => entry.id === profileId) || pi.profiles[0];
        if (!profile) {
            throw new Error('Pi profile is not configured');
        }
        const piSessionId = isResume && bucketSessionId ? bucketSessionId : '';
        console.log(`[jaw:pi] isResume=${isResume}, bucketSessionId=${bucketSessionId || 'none'}, piSessionId=${piSessionId || 'new'}`);
        const piPrompt = piSessionId ? prompt : withHistoryPrompt(prompt, historyBlock);
        const traceRunId = startTraceRun({ cli, model: runtimeModel, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience });
        const ctx: SpawnContext = {
            fullText: '',
            traceLog: [],
            toolLog: [],
            seenToolKeys: new Set<string>(),
            hasClaudeStreamEvents: false,
            sessionId: null,
            cost: null,
            turns: null,
            duration: null,
            tokens: null,
            stderrBuf: '',
            hasActiveSubAgent: false,
            showReasoning: settings["showReasoning"] === true,
            outputTextStarted: false,
            effectiveProvider: profile.id,
            thinkingBuf: '',
            liveOutputText: '',
            liveScope: effectiveLiveScope,
            parentLiveScope: parentLiveScopeForChild,
            traceRunId,
            traceAudience,
        };
        function flushPiThinking() {
            if (!ctx.thinkingBuf) return;
            const merged = ctx.thinkingBuf.trim();
            if (merged) {
                const singleLine = merged.replace(/\s+/g, ' ').trim();
                const label = singleLine.length > 120 ? `${singleLine.slice(0, 119)}…` : singleLine;
                const tool = stripUndefined({ icon: '💭', label, toolType: 'thinking' as const, detail: merged }) as ToolEntry;
                stampTraceTool(tool, ctx, 'thinking');
                ctx.toolLog.push(tool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                appendParentLiveRunTool(ctx, tool);
                broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag }, traceAudience);
            }
            ctx.thinkingBuf = '';
        }
        const piToolDiscipline = [
            '[Pi Tool Discipline]',
            'Your available tools are strictly lowercase: read, bash, edit, write, grep, find, ls.',
            'Capitalized variants (Read, Bash, Edit, Write, Grep, Find, Ls) do NOT exist and will fail.',
        ].join('\n');
        const piSysPrompt = sysPrompt ? `${sysPrompt}\n\n${piToolDiscipline}` : piToolDiscipline;
        const { child, done } = spawnPiRpc(profile, pi, {
            prompt: piPrompt,
            model: runtimeModel,
            ...(piSessionId ? { sessionId: piSessionId } : {}),
            effort,
            cwd: spawnCwd,
            sysPrompt: piSysPrompt,
            onEvent: (event) => {
                opts.lifecycle?.onActivity?.('pi-rpc');
                if (event.kind === 'thinking') {
                    ctx.thinkingBuf = (ctx.thinkingBuf || '') + event.text;
                    return;
                }
                if (event.kind === 'text') {
                    flushPiThinking();
                    const delta = String(event.text || '');
                    if (!delta) return;
                    ctx.fullText += delta;
                    const displayDelta = normalizeAssistantDisplayText(delta);
                    if (ctx.liveOutputText !== undefined) ctx.liveOutputText += displayDelta;
                    if (!ctx.outputTextStarted) ctx.outputTextStarted = true;
                    broadcastAgentOutput(ctx, agentLabel, cli, displayDelta, empTag, traceAudience);
                    return;
                }
                if (event.kind === 'tool') {
                    flushPiThinking();
                    const tool = stripUndefined({ icon: '🔧', label: event.label, status: event.status, detail: event.detail, toolType: 'tool' as const }) as ToolEntry;
                    stampTraceTool(tool, ctx, 'tool');
                    ctx.toolLog.push(tool);
                    if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                    appendParentLiveRunTool(ctx, tool);
                    broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag }, traceAudience);
                    return;
                }
                if (event.kind === 'session') {
                    ctx.sessionId = event.sessionId;
                }
            },
        });
        const piWatchdog = attachWatchdog(child, agentLabel, (reason) => {
            console.log(`[jaw:watchdog] killing ${agentLabel} (pi) — ${reason}`);
            ctx.stallReason = reason;
            if (child.pid) {
                killProcessTree(child.pid, 'SIGTERM');
                const pid = child.pid;
                setTimeout(() => {
                    try { killProcessTree(pid, 'SIGKILL'); } catch { /* already dead */ }
                }, 5_000);
            }
        });
        ctx.stallWatchdog = piWatchdog;

        if (mainManaged) activeProcess = child;
        if (activeProcesses.has(agentLabel)) {
            console.warn(`[spawn:dup] activeProcesses already has child for ${agentLabel} — orphaning previous reference`);
        }
        activeProcesses.set(agentLabel, child);
        if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, provider: profile.id, ...empTag });
        if (mainManaged && !opts.internal) {
            beginLiveRun(liveScope, cli);
            setLiveRunTraceId(liveScope, traceRunId);
        }
        if (mainManaged && !opts.internal && !opts._skipInsert) {
            insertMessage.run('user', prompt, cli, runtimeModel, settings["workingDir"] || null, getActiveChatSession());
        }
        if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, provider: profile.id, ...empTag }, traceAudience);

        done.then((result) => {
            piWatchdog.stop();
            flushPiThinking();
            if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += result.stderr || '';
            if (result.sessionId) ctx.sessionId = result.sessionId;
            if (!ctx.fullText && result.text) ctx.fullText = result.text;
            cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
            opts.lifecycle?.onExit?.(result.code);
            const killReason = consumeKillReason(child.pid);
            const wasKilled = !!killReason;
            const wasSteer = killReason === 'steer';
            const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, result.code, cli);
            return handleAgentExit({
                ctx, code: result.code, cli, model: runtimeModel, effectiveProvider: profile.id, agentLabel, mainManaged, origin,
                resumeKey,
                prompt, opts, cfg, ownerGeneration, forceNew, empSid,
                isResume: false, wasKilled, wasSteer, smokeResult,
                effortDefault: 'medium', costLine: '',
                resolve: resolve!,
                activeProcesses,
                setActiveProcess: (v) => { activeProcess = v; },
                retryState: queueCtrl.retryState,
                fallbackState: queueCtrl.fallbackState,
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue,
            });
        }).catch((err: Error) => {
            piWatchdog.stop();
            if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += err.message;
            console.error('[jaw:pi] runtime failed:', err.message);
            handleAgentExit({
                ctx, code: 1, cli, model: runtimeModel, effectiveProvider: profile.id, agentLabel, mainManaged, origin,
                resumeKey,
                prompt, opts, cfg, ownerGeneration, forceNew, empSid,
                isResume: false, wasKilled: false, wasSteer: false, smokeResult: detectSmokeResponse('', [], 1, cli),
                effortDefault: 'medium', costLine: '',
                resolve: resolve!,
                activeProcesses,
                setActiveProcess: (v) => { activeProcess = v; },
                retryState: queueCtrl.retryState,
                fallbackState: queueCtrl.fallbackState,
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue,
            }).catch((handleErr: Error) => {
                console.error('[jaw:lifecycle] handleAgentExit failed (Pi):', handleErr.message);
            });
        });

        return { child, promise: resultPromise };
    }

    // ─── Codex AppServer branch ────────────────────
    if (cli === 'codex-app') {
        const appClient = new CodexAppClient({
            binary: detected.path || 'codex',
            workDir: spawnCwd,
            env: spawnEnv,
            model,
            effort,
            fastMode: cfg.fastMode ?? settings["perCli"]?.["codex"]?.fastMode,
        });
        appClient.spawn();
        const child = appClient.proc;
        if (!child) {
            throw new Error('Codex AppServer process was not created');
        }
        if (mainManaged) activeProcess = child;
        if (activeProcesses.has(agentLabel)) {
            console.warn(`[spawn:dup] activeProcesses already has child for ${agentLabel} — orphaning previous reference`);
        }
        activeProcesses.set(agentLabel, child);
        if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...empTag });
        if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);

        let codexAppSettled = false;
        appClient.on('error', (err: Error) => {
            if (codexAppSettled) return;
            codexAppSettled = true;
            appClient.cleanup();
            cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
            opts.lifecycle?.onExit?.(null);
            const msg = `Codex AppServer spawn failed: ${err.message}`;
            console.error(`[codex-app:error] ${msg}`);
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
            insertMessage.run('user', prompt, cli, model, settings["workingDir"] || null, getActiveChatSession());
        }
        if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag }, traceAudience);

        const traceRunId = startTraceRun({ cli, model, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience });
        if (mainManaged && !opts.internal) setLiveRunTraceId(liveScope, traceRunId);
        const ctx: CopilotSpawnContext = {
            fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set<string>(),
            hasClaudeStreamEvents: false, sessionId: null as string | null, cost: null as number | null,
            turns: null as number | null, duration: null as number | null, tokens: null, stderrBuf: '',
            thinkingBuf: '',
            liveScope: effectiveLiveScope,
            parentLiveScope: parentLiveScopeForChild,
            traceRunId,
            traceAudience,
        };

        function flushCodexAppThinking() {
            if (!ctx.thinkingBuf) return;
            const merged = ctx.thinkingBuf.trim();
            if (merged) {
                const singleLine = merged.replace(/\s+/g, ' ').trim();
                const label = singleLine.length > 120 ? `${singleLine.slice(0, 119)}…` : singleLine;
                console.log(`  💭 ${label}`);
                const tool = { icon: '💭', label, toolType: 'thinking' as const, detail: merged };
                stampTraceTool(tool, ctx, 'thinking');
                ctx.toolLog.push(tool);
                if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                appendParentLiveRunTool(ctx, tool);
                broadcast('agent_tool', { agentId: agentLabel, ...tool, ...empTag }, traceAudience);
            }
            ctx.thinkingBuf = '';
        }

        let lastVisibleBroadcastTs = Date.now();
        let heartbeatSent = false;

        appClient.on('notification', (method: string, params: Record<string, unknown>) => {
            if (method === 'turn/completed' || method === 'turn/started' || method === 'error') {
                console.log(`[codex-app:notify] ${method}`);
            }
            appendTraceEvent({ runId: ctx.traceRunId, source: 'codex_app_raw', eventType: method, raw: params });
            const parsed = extractFromCodexAppEvent(method, params, ctx);
            if (!parsed) return;

            if (parsed.flushThinking) {
                flushCodexAppThinking();
            }
            if (parsed.tool) {
                const parsedTool = parsed.tool;
                if (parsedTool.icon === '💭') {
                    ctx.thinkingBuf += parsedTool.detail || parsedTool.label;
                    return;
                }
                flushCodexAppThinking();
                const key = `${parsedTool.icon}:${parsedTool.label}:${parsedTool.stepRef || ''}:${parsedTool.status || ''}`;
                if (!ctx.seenToolKeys.has(key)) {
                    ctx.seenToolKeys.add(key);
                    stampTraceTool(parsedTool, ctx, parsedTool.toolType || 'tool');
                    ctx.toolLog.push(parsedTool);
                    if (ctx.liveScope) replaceLiveRunTools(ctx.liveScope, ctx.toolLog);
                    appendParentLiveRunTool(ctx, parsedTool);
                    broadcast('agent_tool', { agentId: agentLabel, ...parsedTool, ...empTag }, traceAudience);
                    lastVisibleBroadcastTs = Date.now();
                    heartbeatSent = false;
                }
            }
    if (parsed.text) {
                flushCodexAppThinking();
                const segment = appendAssistantTextSegment(ctx, parsed.text);
                if (segment) {
                    broadcastAgentOutput(ctx, agentLabel, cli, segment, empTag, traceAudience);
                    lastVisibleBroadcastTs = Date.now();
                    heartbeatSent = false;
                }
            }
            if (parsed.sessionId && !ctx.sessionId) {
                ctx.sessionId = parsed.sessionId;
            }
            if (parsed.tokens) {
                ctx.tokens = parsed.tokens;
            }
            if (parsed.turnStatus && parsed.turnStatus !== 'completed') {
                console.warn(`[codex-app:turn] final status: ${parsed.turnStatus}`);
                turnCompleted = false;
            }
            opts.lifecycle?.onActivity?.('codex-app');
        });

        appClient.on('stderr', (text: string) => {
            appendTraceEvent({ runId: ctx.traceRunId, source: 'stderr', eventType: 'stderr', raw: text });
            if (ctx.stderrBuf.length < 4000) {
                ctx.stderrBuf += text + '\n';
            }
            opts.lifecycle?.onActivity?.('stderr');
            if (shouldEmitHeartbeat(lastVisibleBroadcastTs, heartbeatSent)) {
                heartbeatSent = true;
                const elapsed = Math.round((Date.now() - lastVisibleBroadcastTs) / 1000);
                console.log(`  ⏳ agent active (no visible event for ${elapsed}s)`);
                broadcast('agent_tool', {
                    agentId: agentLabel,
                    icon: '⏳',
                    label: 'working... (no visible progress)',
                    ...empTag,
                }, traceAudience);
            }
        });

        let turnCompleted = false;
        (async () => {
            try {
                const initResult = await appClient.initialize();
                if (process.env["DEBUG"]) console.log('[codex-app:init]', JSON.stringify(initResult).slice(0, 200));

                if (isResume && resumeSessionId) {
                    try {
                        await appClient.resumeThread(resumeSessionId);
                        console.log(`[codex-app:session] resumeThread OK: ${resumeSessionId.slice(0, 12)}...`);
                    } catch (resumeErr: unknown) {
                        console.warn(`[codex-app:session] resumeThread FAILED: ${(resumeErr as Error).message} — starting new thread`);
                        if (empSid && opts.agentId) {
                            clearEmployeeSession.run(opts.agentId);
                        }
                        await appClient.startThread({ instructions: sysPrompt, cwd: spawnCwd });
                    }
                } else {
                    await appClient.startThread({ instructions: sysPrompt, cwd: spawnCwd });
                }
                ctx.sessionId = appClient.threadId;

                const useNativeResume = isResume && Boolean(resumeSessionId);
                const codexAppPrompt = (!useNativeResume && historyBlock)
                    ? `${historyBlock}\n\n[User Message]\n${prompt}`
                    : prompt;

                const turnDone = new Promise<void>((resolveTurn, rejectTurn) => {
                    appClient.once('turn/completed', () => {
                        appClient.removeListener('error', rejectTurn);
                        resolveTurn();
                    });
                    appClient.once('error', rejectTurn);
                });

                await appClient.startTurn(codexAppPrompt);

                try {
                    await turnDone;
                    turnCompleted = true;
                } catch (turnErr: unknown) {
                    console.warn(`[codex-app:turn] error during turn: ${(turnErr as Error).message}`);
                }

                flushCodexAppThinking();

                const persistedThreadId = appClient.threadId;
                if (persistedThreadId && persistMainSession(stripUndefined({
                    ownerGeneration,
                    forceNew,
                    employeeSessionId: empSid,
                    sessionId: persistedThreadId,
                    isFallback: opts._isFallback,
                    cli,
                    model,
                    resumeKey,
                    effort: cfg.effort || '',
                    skipSessionPersist: opts._skipSessionPersist === true,
                }))) {
                    console.log(`[jaw:session] saved ${cli} session=${persistedThreadId.slice(0, 12)}... (pre-shutdown)`);
                }

                if (!codexAppSettled) {
                    codexAppSettled = true;
                    const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, 0, cli);
                    handleAgentExit({
                        ctx, code: turnCompleted ? 0 : 1, cli, model, agentLabel, mainManaged, origin,
                        resumeKey,
                        prompt, opts, cfg, ownerGeneration, forceNew, empSid,
                        isResume, wasKilled: false, wasSteer: false, smokeResult,
                        effortDefault: '', costLine: '',
                        resolve: resolve!,
                        activeProcesses,
                        setActiveProcess: (v) => { activeProcess = v; },
                        retryState: queueCtrl.retryState,
                        fallbackState: queueCtrl.fallbackState,
                        fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                        processQueue,
                    }).catch((err: Error) => {
                        console.error(`[codex-app:handleAgentExit] ${err.message}`);
                    });
                }

                await appClient.closeGracefully();
            } catch (err: unknown) {
                console.error(`[codex-app:error] ${(err as Error).message}`);
                if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += (err as Error).message;
                appClient.kill();
            }
        })();

        appClient.on('exit', (code: number | null, signal: string | null) => {
            if (codexAppSettled) return;
            codexAppSettled = true;
            appClient.cleanup();
            cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
            opts.lifecycle?.onExit?.(code ?? null);
            const killReason = consumeKillReason(appClient.proc?.pid);
            if (code !== 0 && !killReason) {
                console.warn(`[codex-app:unexpected-exit] code=${code} signal=${signal} threadId=${ctx.sessionId || 'none'}`);
            }
            const wasKilled = !!killReason;
            const wasSteer = killReason === 'steer';
            flushCodexAppThinking();

            const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, code, cli);
            const codexAppCode = turnCompleted ? 0 : (code ?? 1);

            handleAgentExit({
                ctx, code: codexAppCode, cli, model, agentLabel, mainManaged, origin,
                resumeKey,
                prompt, opts, cfg, ownerGeneration, forceNew, empSid,
                isResume, wasKilled, wasSteer, smokeResult,
                effortDefault: '', costLine: '',
                resolve: resolve!,
                activeProcesses,
                setActiveProcess: (v) => { activeProcess = v; },
                retryState: queueCtrl.retryState,
                fallbackState: queueCtrl.fallbackState,
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue,
            }).catch((err: Error) => {
                console.error('[jaw:lifecycle] handleAgentExit failed (codex-app):', err.message);
            });
        });

        return { child, promise: resultPromise };
    }

    // ─── Standard CLI branch (claude/codex/gemini/opencode) ──────
    // DIFF-B: Windows needs shell:true only when falling back to .cmd shims.
    const spawnCommand = cli === 'opencode' && process.platform !== 'win32'
        ? (resolvedOpencodeBinary || detected.path || cli)
        : (detected.path || cli);
    const windowsSpawnUsesShell = process.platform === 'win32'
        && !spawnCommand.toLowerCase().endsWith('.exe');
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
        ...(windowsSpawnUsesShell ? { shell: true } : {}),
    });
    if (mainManaged) activeProcess = child;
    // Phase 7-3: detect duplicate spawn for same agentLabel.
    if (activeProcesses.has(agentLabel)) {
        console.warn(`[spawn:dup] activeProcesses already has child for ${agentLabel} — orphaning previous reference`);
    }
    activeProcesses.set(agentLabel, child);
    if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...runtimeStatusMeta, ...empTag });
    if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);

    // ─── DIFF-A: error guard — prevent uncaught ENOENT crash ───
    let stdSettled = false;  // guard: error→close can fire sequentially
    let lastOpencodeIoAt = Date.now();
    let opencodeIdleTimer: ReturnType<typeof setInterval> | null = null;
    let agyQuietCompletionTimer: ReturnType<typeof setTimeout> | null = null;
    const clearOpencodeIdleTimer = () => {
        if (!opencodeIdleTimer) return;
        clearInterval(opencodeIdleTimer);
        opencodeIdleTimer = null;
    };
    const clearAgyQuietCompletionTimer = () => {
        if (!agyQuietCompletionTimer) return;
        clearTimeout(agyQuietCompletionTimer);
        agyQuietCompletionTimer = null;
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
        clearOpencodeIdleTimer();
        clearAgyQuietCompletionTimer();
        if (stdSettled) return;
        stdSettled = true;
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
        opts.lifecycle?.onExit?.(null);
        const msg = err.code === 'ENOENT'
            ? `CLI '${cli}' 실행 실패 (ENOENT). 설치/경로를 확인하세요.`
            : err.code === 'ENOEXEC'
                ? `CLI '${cli}' 실행 실패 (ENOEXEC). PATH의 실행 파일이 바이너리 또는 shebang 스크립트가 아닙니다. \`jaw doctor --json\`으로 깨진 shim을 확인하세요.`
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
        insertMessage.run('user', prompt, cli, runtimeModel, settings["workingDir"] || null, getActiveChatSession());
    }

    if (cli === 'claude') {
        child.stdin.write(withHistoryPrompt(prompt, historyBlock));
    } else if (cli === 'claude-e' || (cli === 'ai-e' && effectiveProvider === 'claude')) {
        child.stdin.write(isResume ? prompt : withHistoryPrompt(prompt, historyBlock));
    } else if (cli === 'codex' && !isResume) {
        const codexStdin = historyBlock
            ? `${historyBlock}\n\n[User Message]\n${prompt}`
            : `[User Message]\n${prompt}`;
        child.stdin.write(codexStdin);
    }
    child.stdin.end();

    if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...runtimeStatusMeta, ...empTag }, traceAudience);

    const traceRunId = startTraceRun({ cli, model: runtimeModel, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience });
    if (mainManaged && !opts.internal) setLiveRunTraceId(liveScope, traceRunId);
    const kiroPlainText = isKiroPlainTextCli(cli, effectiveProvider);
    const kiroSpawnStartedAt = kiroPlainText ? Date.now() - 1000 : 0;
    const kiroConversationIdsBefore = (kiroPlainText && !isResume && !empSid)
        ? listKiroConversationIdsForCwd(spawnCwd)
        : null;
    // Native `agy --conversation ... -p` may emit only the current answer.
    // Length-based replay trimming can therefore swallow the whole new answer.
    const agyResumeOffset = 0;
    const ctx: SpawnContext = {
        fullText: '',
        traceLog: [],
        toolLog: [],
        seenToolKeys: new Set<string>(),
        hasClaudeStreamEvents: false,
        sessionId: (kiroPlainText && isResume && resumeSessionId) ? resumeSessionId : null,
        cost: null as number | null,
        turns: null as number | null,
        duration: null as number | null,
        tokens: null,
        stderrBuf: '',
        hasActiveSubAgent: false,
        showReasoning: settings["showReasoning"] === true,
        outputTextStarted: false,
        effectiveProvider,
        liveScope: effectiveLiveScope,
        parentLiveScope: parentLiveScopeForChild,
        traceRunId,
        traceAudience,
        geminiResultSeen: false,
        ...(opencodeSpawnAudit ? { opencodeSpawnAudit: opencodeSpawnAudit as Record<string, unknown> } : {}),
        ...(agyResumeOffset > 0 ? { agyResumeOffset, agyBytesReceived: 0 } : {}),
        ...(kiroPlainText || cli === 'agy' || cli === 'pi' ? { liveOutputText: '' } : {}),
        ...(kiroPlainText ? { kiroLastVisibleAt: Date.now(), kiroHeartbeatSent: false } : {}),
    };
    let geminiWatchdog: ReturnType<typeof setTimeout> | null = null;
    let agyClosing = false;
    const scheduleAgyQuietCompletion = () => {
        if (cli !== 'agy') return;
        if (agyClosing) return;
        clearAgyQuietCompletionTimer();
        const quietCompletionDelayMs = getAgyQuietCompletionDelayMs(ctx);
        if (quietCompletionDelayMs === null) return;
        agyQuietCompletionTimer = setTimeout(() => {
            agyQuietCompletionTimer = null;
            if (!child.pid || getAgyQuietCompletionDelayMs(ctx) === null) return;
            console.log(`[jaw:agy] output quiet for ${quietCompletionDelayMs}ms — completing print run`);
            killReasons.set(child.pid, AGY_COMPLETE_KILL_REASON);
            try {
                killProcessTree(child.pid, 'SIGTERM');
                setTimeout(() => {
                    try {
                        if (child.pid) killProcessTree(child.pid, 'SIGKILL');
                    } catch { /* already dead */ }
                }, DEFAULT_KILL_ESCALATION_MS);
            } catch (e) {
                console.warn('[jaw:agy] quiet completion kill failed:', (e as Error).message);
            }
        }, quietCompletionDelayMs);
    };

    // ─── Subprocess stall watchdog (Phase 1: #178 OAuth2 stall recovery) ───
    const rawAgentTimeoutCfg = (settings as Record<string, unknown>)["agentTimeout"];
    const gCfg = rawAgentTimeoutCfg && typeof rawAgentTimeoutCfg === 'object'
        ? rawAgentTimeoutCfg as Record<string, unknown> : {};
    const cCfg = gCfg[cli] && typeof gCfg[cli] === 'object'
        ? gCfg[cli] as Record<string, unknown> : {};
    const agentTimeoutCfg = { ...gCfg, ...cCfg };
    const watchdogConfig: { firstProgressMs?: number; idleMs?: number; absoluteMs?: number; absoluteHardCapMs?: number } = {};
    if (typeof agentTimeoutCfg['firstProgressMs'] === 'number') watchdogConfig.firstProgressMs = agentTimeoutCfg['firstProgressMs'];
    if (typeof agentTimeoutCfg['idleMs'] === 'number') watchdogConfig.idleMs = agentTimeoutCfg['idleMs'];
    if (typeof agentTimeoutCfg['absoluteMs'] === 'number') watchdogConfig.absoluteMs = agentTimeoutCfg['absoluteMs'];
    if (typeof agentTimeoutCfg['absoluteHardCapMs'] === 'number') watchdogConfig.absoluteHardCapMs = agentTimeoutCfg['absoluteHardCapMs'];
    const stallWatchdog = attachWatchdog(child, agentLabel, (reason) => {
        console.log(`[jaw:watchdog] killing ${agentLabel} — ${reason}`);
        ctx.stallReason = reason;
        if (child.pid) {
            killProcessTree(child.pid, 'SIGTERM');
            setTimeout(() => {
                try { killProcessTree(child.pid!, 'SIGKILL'); } catch { /* already dead */ }
            }, 5_000);
        }
    }, watchdogConfig);
    ctx.stallWatchdog = stallWatchdog;

    let agyTranscriptWatcher: AgyTranscriptWatcherHandle | null = null;
    if (cli === 'agy') {
        agyTranscriptWatcher = startAgyTranscriptWatcher({
            cwd: spawnCwd,
            prompt: promptForArgs,
            getSessionId: () => ctx.sessionId,
            ctx,
            agentLabel,
            cli,
            empTag,
            traceAudience,
            onEmit: (emitCtx, tool, label, _cliName, tag, audience) => {
                stampTraceTool(tool, emitCtx, tool.toolType || 'tool');
                if (emitCtx.liveScope) replaceLiveRunTools(emitCtx.liveScope, emitCtx.toolLog);
                appendParentLiveRunTool(emitCtx, tool);
                broadcast('agent_tool', { agentId: label, ...tool, ...tag }, audience);
                scheduleAgyQuietCompletion();
            },
            onActivity: () => {
                scheduleAgyQuietCompletion();
            },
        });
    }

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
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'malformed_json', raw: line });
            return;
        }
        appendTraceEvent({
            runId: ctx.traceRunId,
            source: 'cli_raw',
            eventType: fieldString(asCliEventRecord(raw).type, '<no-type>'),
            raw,
        });
        // claude-e / ai-e Claude: intercept jaw_runtime events BEFORE discriminator
        if ((cli === 'claude-e' || cli === 'ai-e') && isJawRuntimeEvent(raw)) {
            const rtEvt = raw as Record<string, unknown>;
            handleJawRuntimeEvent(rtEvt, agentLabel);
            // Extract sessionId from session_started or interrupted
            const evtName = rtEvt['event'];
            if ((evtName === 'session_started' || evtName === 'interrupted') && typeof rtEvt['sessionId'] === 'string') {
                ctx.sessionId = rtEvt['sessionId'] as string;
            }
            if (evtName === 'error' && typeof rtEvt['message'] === 'string') {
                const message = `[jaw:${cli}:error] ${rtEvt['message']}`;
                if (ctx.stderrBuf.length < 4000) ctx.stderrBuf = ctx.stderrBuf ? `${ctx.stderrBuf}\n${message}` : message;
                pushTrace(ctx, message);
            }
            return;
        }
        const dispatchCli = cli === 'ai-e'
            ? (ctx.effectiveProvider === 'claude' ? 'claude-e' : (ctx.effectiveProvider || 'ai-e'))
            : cli;
        const event = discriminate(dispatchCli, raw);
        if (!event) {
            const type = fieldString(asCliEventRecord(raw).type, '<no-type>');
            pushTrace(ctx, `[cli:unknown-event] cli=${cli} provider=${dispatchCli} type=${type} preview=${JSON.stringify(raw).slice(0, 200)}`);
            return;
        }
        recordOpencodeEvent(line, event);
        if (process.env["DEBUG"]) {
            console.log(`[jaw:event:${agentLabel}] ${cli} type=${event.type}`);
            console.log(`[jaw:raw:${agentLabel}] ${line.slice(0, 300)}`);
        }
        logEventSummary(agentLabel, dispatchCli, event, ctx);
        if (!ctx.sessionId) ctx.sessionId = extractSessionId(dispatchCli, event);
        extractFromEvent(dispatchCli, event, ctx, agentLabel, empTag);
        // Gemini watchdog: AFTER extractFromEvent sets geminiResultSeen
        if (dispatchCli === 'gemini' && ctx.geminiResultSeen && !geminiWatchdog) {
            geminiWatchdog = setTimeout(() => {
                console.warn(`[jaw:gemini-watchdog] ${agentLabel} — result seen but close not received after 10s, killing`);
                try { child.kill('SIGTERM'); } catch { /* already dead */ }
            }, 10000);
        }
        // Sub-agent wait: keep stall timer alive
        if (ctx.hasActiveSubAgent) {
            opts.lifecycle?.onActivity?.('heartbeat');
        }
        const outputChunk = extractOutputChunk(dispatchCli, event, ctx);
        if (outputChunk) {
            broadcastAgentOutput(ctx, agentLabel, cli, outputChunk, empTag, (opts.internal || isEmployee) ? 'internal' : 'public');
        }
    };
    if (cli === 'opencode') {
        opencodeIdleTimer = setInterval(() => {
            const idleMs = Date.now() - lastOpencodeIoAt;
            if (idleMs < 60_000) return;
            const snapshot = buildOpencodeRuntimeSnapshot(ctx);
            const line = `[jaw:opencode:idle] ${idleMs}ms ${JSON.stringify(snapshot)}`;
            console.warn(line);
            pushTrace(ctx, line);
        }, 30_000);
    }

    const agyUtf8 = cli === 'agy' ? new StringDecoder('utf8') : null;
    const kiroUtf8 = kiroPlainText ? new StringDecoder('utf8') : null;

    child.stdout.on('data', (chunk) => {
        opts.lifecycle?.onActivity?.('stdout');
        lastOpencodeIoAt = Date.now();
        if (cli === 'agy') {
            const rawText = agyUtf8!.write(chunk);
            if (!rawText) return;
            // Defensive ANSI strip (belt-and-suspenders with NO_COLOR=1)
            const text = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
            if (ctx.fullText.length < 102_400) ctx.fullText += text;
            else if (ctx.fullText.length < 102_500) ctx.fullText += text.slice(0, 102_400 - ctx.fullText.length);
            if (!ctx.sessionId) ctx.sessionId = extractAgyConversationId(ctx.fullText);
            if (ctx.agyResumeOffset && ctx.agyResumeOffset > 0) {
                ctx.agyBytesReceived = (ctx.agyBytesReceived ?? 0) + text.length;
                if (ctx.agyBytesReceived <= ctx.agyResumeOffset) return;
                const newStart = text.length - (ctx.agyBytesReceived - ctx.agyResumeOffset);
                const newText = normalizeAssistantDisplayText(newStart > 0 ? text.slice(newStart) : text);
                ctx.agyResumeOffset = 0;
                if (!newText) return;
                if (ctx.liveOutputText !== undefined) ctx.liveOutputText += newText;
                ctx.outputTextStarted = true;
                appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'plain_text', raw: newText });
                broadcastAgentOutput(ctx, agentLabel, cli, newText, empTag, traceAudience);
                scheduleAgyQuietCompletion();
                return;
            }
            const visibleFullText = isResume
                ? stripAgyResumeReplayPrefixes(ctx.fullText, agyResumeReplayPrefixes).text
                : ctx.fullText;
            const promptEchoStripped = stripAgyPromptEchoPrefix(visibleFullText, promptForArgs).text;
            const trackerStripped = stripInterviewTracker(promptEchoStripped);
            const displayFullText = normalizeAssistantDisplayText(trackerStripped);
            const previousDisplayText = ctx.liveOutputText ?? '';
            const displayText = displayFullText.startsWith(previousDisplayText)
                ? displayFullText.slice(previousDisplayText.length)
                : displayFullText;
            if (ctx.liveOutputText !== undefined) ctx.liveOutputText = displayFullText;
            ctx.outputTextStarted = Boolean(displayFullText.trim());
            if (!displayText) {
                scheduleAgyQuietCompletion();
                return;
            }
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'plain_text', raw: displayText });
            broadcastAgentOutput(ctx, agentLabel, cli, displayText, empTag, traceAudience);
            scheduleAgyQuietCompletion();
            return;
        }
        if (kiroPlainText) {
            const text = kiroUtf8!.write(chunk);
            if (!text) return;
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'plain_text', raw: text });
            const events = processKiroStdoutChunk(ctx, text);
            if (events.length) {
                emitKiroStreamEvents(events, ctx, agentLabel, cli, empTag, traceAudience);
            }
            return;
        }
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
        clearAgyQuietCompletionTimer();
        lastOpencodeIoAt = Date.now();
        const text = chunk.toString().trim();
        appendTraceEvent({ runId: ctx.traceRunId, source: 'stderr', eventType: 'stderr', raw: text });
        console.error(`[jaw:stderr:${agentLabel}] ${text}`);
        if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += text + '\n';
        scheduleAgyQuietCompletion();
    });

    child.on('close', (code) => {
        clearOpencodeIdleTimer();
        clearAgyQuietCompletionTimer();
        stallWatchdog.stop();
        if (geminiWatchdog) { clearTimeout(geminiWatchdog); geminiWatchdog = null; }
        if (stdSettled) return;  // error handler already resolved
        // [I1] Flush residual NDJSON buffer — last event may lack trailing newline
        if (buffer.trim()) {
            dispatchNdjsonLine(buffer);
            buffer = '';
        }
        flushClaudeBuffers(ctx, agentLabel, empTag);  // flush any pending thinking/input buffers
        if (cli === 'opencode') flushOpenCodeBuffers(ctx, agentLabel, empTag);
        if (agyUtf8) {
            const remaining = agyUtf8.end();
            if (remaining) ctx.fullText += remaining;
        }
        if (kiroUtf8) {
            const remaining = kiroUtf8.end();
            if (remaining) {
                emitKiroStreamEvents(processKiroStdoutChunk(ctx, remaining), ctx, agentLabel, cli, empTag, traceAudience);
            }
            emitKiroStreamEvents(flushKiroStdoutContext(ctx), ctx, agentLabel, cli, empTag, traceAudience);
        }
        const agyTotalOutputLen = cli === 'agy' ? ctx.fullText.length : 0;
        if (cli === 'agy' && agyResumeOffset > 0) {
            ctx.fullText = ctx.fullText.slice(Math.min(agyResumeOffset, ctx.fullText.length));
        }
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);

        // [I2] Consume per-process kill reason
        const stdKillReason = consumeKillReason(child.pid);
        const agyCompletedByQuietOutput = cli === 'agy' && stdKillReason === AGY_COMPLETE_KILL_REASON;
        const wasKilled = !!stdKillReason && !agyCompletedByQuietOutput;
        const wasSteer = stdKillReason === 'steer';

        if (cli === 'agy' && !ctx.sessionId) ctx.sessionId = extractAgyConversationId(ctx.fullText);
        if (cli === 'agy' && agyLogFile && !ctx.sessionId) {
            try {
                if (fs.existsSync(agyLogFile)) {
                    ctx.sessionId = extractAgyConversationId(fs.readFileSync(agyLogFile, 'utf8'));
                }
            } catch (e) {
                console.warn('[jaw:agy] log session capture failed:', (e as Error).message);
            }
        }
        if (cli === 'agy' && agyLogFile) {
            try { fs.rmSync(agyLogFile, { force: true }); }
            catch (e) { console.warn('[jaw:agy] log cleanup failed:', (e as Error).message); }
        }
        agyClosing = true;
        agyTranscriptWatcher?.stop();
        if (cli === 'agy' && isResume && isAgyStaleSessionOutput(ctx.fullText)) {
            console.log(`[jaw:agy] stale session detected (Warning: conversation not found) — clearing bucket`);
            try {
                const bucket = resolveSessionBucket(cli, runtimeModel, effectiveProvider);
                clearSessionBucket.run(bucket);
            } catch (e) { console.warn('[jaw:agy] stale bucket clear failed:', (e as Error).message); }
            ctx.sessionId = null;
        }
        if (kiroPlainText) {
            const captured = captureKiroSessionIdAfterExit({
                cwd: spawnCwd,
                spawnStartedAt: kiroSpawnStartedAt,
                beforeIds: kiroConversationIdsBefore,
                stdout: ctx.fullText,
                stderr: ctx.stderrBuf,
                resumeSessionId,
                isResume,
            });
            ctx.sessionId = captured.id;
            if (captured.source) {
                console.log(`[jaw:kiro] session capture source=${captured.source} id=${captured.id?.slice(0, 12) ?? 'none'}...`);
            }
            if (!ctx.sessionId) {
                console.warn(`[jaw:kiro] session id capture failed cwd=${spawnCwd}`);
            }
            if (isResume && isKiroStaleSessionOutput(ctx.fullText)) {
                console.log('[jaw:kiro] stale session detected in output — clearing bucket');
                try {
                    const bucket = resolveSessionBucket(cli, runtimeModel, effectiveProvider);
                    clearSessionBucket.run(bucket);
                } catch (e) { console.warn('[jaw:kiro] stale bucket clear failed:', (e as Error).message); }
                ctx.sessionId = null;
            }
            const parsed = finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer);
            const best = [ctx.liveOutputText, ctx.kiroDisplayedText, parsed]
                .map((value) => normalizeAssistantDisplayText(value))
                .map((value) => String(value || '').trim())
                .filter(Boolean)
                .sort((a, b) => b.length - a.length)[0];
            if (best) ctx.fullText = best;
            else if (parsed) ctx.fullText = parsed;
        }
        // ai-e codex/grok: capture session ID from stderr footer
        if (cli === 'ai-e' && !kiroPlainText && effectiveProvider !== 'claude' && !ctx.sessionId) {
            const fromStderr = parseAiESessionIdFromStderr(ctx.stderrBuf);
            if (fromStderr) {
                ctx.sessionId = fromStderr;
                console.log(`[jaw:ai-e:${effectiveProvider}] session capture id=${fromStderr.slice(0, 16)}...`);
            }
        }
        let agyCloseTimedOut = false;
        let agyTimeoutMessage = '';
        if (cli === 'agy') {
            const strippedPromptEcho = stripAgyPromptEchoPrefix(ctx.fullText, promptForArgs);
            if (strippedPromptEcho.stripped) {
                ctx.fullText = strippedPromptEcho.text;
                if (ctx.liveOutputText !== undefined) {
                    ctx.liveOutputText = stripAgyPromptEchoPrefix(ctx.liveOutputText, promptForArgs).text;
                }
            }
            if (isResume && agyResumeReplayPrefixes.length > 0) {
                const strippedReplays = stripAgyResumeReplayPrefixes(ctx.fullText, agyResumeReplayPrefixes);
                if (strippedReplays.stripped) {
                    ctx.fullText = strippedReplays.text;
                    if (ctx.liveOutputText !== undefined) {
                        ctx.liveOutputText = stripAgyResumeReplayPrefixes(ctx.liveOutputText, agyResumeReplayPrefixes).text;
                    }
                }
            }
            if (isResume && agyResumeReplayPrefix) {
                const strippedReplay = stripAgyResumeReplayPrefix(ctx.fullText, agyResumeReplayPrefix);
                if (strippedReplay.stripped) {
                    ctx.fullText = strippedReplay.text;
                    if (ctx.liveOutputText !== undefined) {
                        ctx.liveOutputText = stripAgyResumeReplayPrefix(ctx.liveOutputText, agyResumeReplayPrefix).text;
                    }
                }
            }
            if (ctx.agyFinalPlannerSeen && ctx.agyFinalPlannerText) {
                ctx.fullText = ctx.agyFinalPlannerText;
                if (ctx.liveOutputText !== undefined) ctx.liveOutputText = ctx.agyFinalPlannerText;
            }
            const normalizedCloseText = normalizeAgyCloseText({
                fullText: ctx.fullText,
                liveOutputText: ctx.liveOutputText,
                allowTimeoutSuffixStrip: Boolean(ctx.agyFinalPlannerSeen),
            });
            ctx.fullText = normalizedCloseText.text;
            if (normalizedCloseText.liveText !== undefined) ctx.liveOutputText = normalizedCloseText.liveText;
            agyCloseTimedOut = normalizedCloseText.timedOut;
            agyTimeoutMessage = normalizedCloseText.timeoutMessage;
        }
        const agyTimedOut = cli === 'agy' && agyCloseTimedOut;
        const effectiveExitCode = agyCompletedByQuietOutput ? 0 : agyTimedOut ? 124 : ctx.stallReason ? 124 : code;
        if (agyTimedOut) {
            const message = formatAgyTimeoutMessage(agyTimeoutMessage);
            ctx.stderrBuf = ctx.stderrBuf ? `${ctx.stderrBuf}\n${message}` : message;
            ctx.fullText = '';
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'runtime_error', raw: message });
        }
        opts.lifecycle?.onExit?.(effectiveExitCode ?? null);

        const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, effectiveExitCode, cli);

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
            ctx, code: effectiveExitCode, cli, model: runtimeModel, effectiveProvider, agentLabel, mainManaged, origin,
            resumeKey,
            prompt, opts, cfg, ownerGeneration, forceNew, empSid,
            isResume, wasKilled, wasSteer, smokeResult,
            effortDefault: cli === 'grok' ? '' : 'medium', costLine,
            resolve: resolve!,
            activeProcesses,
            setActiveProcess: (v) => { activeProcess = v; },
            retryState: queueCtrl.retryState,
            fallbackState: queueCtrl.fallbackState,
            fallbackMaxRetries: FALLBACK_MAX_RETRIES,
            processQueue,
            ...(agyTotalOutputLen > 0 ? { outputLen: agyTotalOutputLen } : {}),
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
