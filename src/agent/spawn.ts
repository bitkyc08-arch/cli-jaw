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
    listQueuedMessages, insertQueuedMessage, deleteQueuedMessage, migrateQueuedMessagesV1ToV2,
    getSessionBucket, clearSessionBucket, setSessionBucketSnapshot,
} from '../core/db.js';
import { sanitizeToolLogForDurableStorage } from '../shared/tool-log-sanitize.js';
import { buildTaskSnapshot } from '../memory/runtime.js';
import { getActiveChatSession } from '../core/chat-sessions.js';
import { currentSessionScope } from '../core/session-context.js';
import { getSystemPrompt, regenerateB } from '../prompt/builder.js';
import { extractSessionId, extractFromEvent, extractFromAcpUpdate, extractOutputChunk, logEventSummary, flushClaudeBuffers, flushOpenCodeBuffers } from './events.js';
import { detectSmokeResponse } from './smoke-detector.js';
import { saveUpload as _saveUpload, buildMediaPrompt, buildMediaPromptMany, type SaveUploadOptions } from '../../lib/upload.js';
import { resolveMainCli, consumePendingBootstrapPrompt, peekPendingBootstrapPrompt } from '../core/main-session.js';
import {
    getSessionOwnershipGeneration,
    persistMainSession,
} from './session-persistence.js';
import { isCompactMarkerRow } from '../core/compact.js';
import { isRuntimeSettingsMutationInFlight, waitForRuntimeSettingsIdle } from '../core/runtime-settings-gate.js';
import { hasBlockingWorkers, hasPendingWorkerReplays, getActiveWorkers, clearAllWorkers, clearWorkersForScope } from '../orchestrator/worker-registry.js';
import { sanitizeWorkerProgressTools } from '../orchestrator/worker-progress.js';
import { handleAgentExit, setSpawnAgent, setMainMetaHandler } from './lifecycle-handler.js';
import { buildServicePath } from '../core/runtime-path.js';
import { LOCAL_SESSION_SCOPE_ACTIVATION, resolveOrcScope } from '../orchestrator/scope.js';
import { stripInterviewTracker } from '../orchestrator/sanitize.js';
import { beginLiveRun, appendLiveRunText, setLiveRunTraceId, clearLiveRun, replaceLiveRunTools, appendLiveRunTool, getLiveRun } from './live-run-state.js';
import {
    memoryFlushCounter as _memoryFlushCounter,
    flushCycleCount as _flushCycleCount,
    setSpawnRef as setMemorySpawnRef,
} from './memory-flush-controller.js';
import { applyCliEnvDefaults, buildSessionResumeKey, ensureOpencodeAlwaysAllowPermissions } from './spawn-env.js';
import { buildPromptForArgs, shouldBuildHistoryBlock, withHistoryPrompt } from './prompt-context.js';
import { attachWatchdog, DEFAULT_WATCHDOG_ABSOLUTE_HARD_CAP_MS } from './watchdog.js';
import {
    buildOpencodeRuntimeSnapshot,
    buildOpencodeSpawnAudit,
    pushOpencodeRawEvent,
    resolveOpencodeBinary,
} from './opencode-diagnostics.js';
import type { SpawnContext, ToolEntry } from '../types/agent.js';
import { asCliEventRecord, discriminate, fieldString, type CliEventRecord } from '../types/cli-events.js';
import type { RemoteTarget } from '../messaging/types.js';
import { isJawRuntimeEvent, handleJawRuntimeEvent } from './claude-e-runtime.js';
import { jawRuntimesByScope, runtimeForScope } from './jwc-runtime.js';
import { applyOutputPolicy, runBeforeSpawnChecks, type PolicyVerdict } from '../core/policy-hooks.js';
import { appendTraceEvent, finalizeTraceRun, stampTraceTool, startTraceRun } from '../trace/store.js';
import {
    AGY_COMPLETE_KILL_REASON,
    appendAgyFullText,
    classifyAgyTranscriptMode,
    describeAgyFinalSource,
    extractAgyConversationId,
    finalizeAgyFallbackText,
    AGY_PLANNER_ONLY_NOTICE,
    isAgyIntermediatePlannerText,
    formatAgyWatchdogContext,
    resolveAgyEmptyCloseError,
    formatAgyTimeoutMessage,
    getAgyQuietCompletionDelayMs,
    isAgyStaleSessionOutput,
    normalizeAgyCloseText,
    shouldFreezeAgyLiveDisplay,
    stripAgyPromptEchoPrefix,
    stripAgyResumeReplayPrefix,
    stripAgyResumeReplayPrefixes,
} from './agy-runtime.js';
import { detectAgyCapabilities } from './agy-capabilities.js';
import {
    buildAgyBootstrapEnvelope,
    resolveAgyPromptOrder,
    type AgyBootstrapEnvelope,
} from './agy-bootstrap.js';
import { startAgyTranscriptWatcher, type AgyTranscriptWatcherHandle } from './agy-transcript-watcher.js';
import { appendAssistantTextSegment, emitAgentTool, normalizeAssistantDisplayText, pushTrace } from './events/helpers.js';
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

export const activeProcesses = new Map<string, ChildProcess>(); // agentId → child process

/** Kill reason recorded when a duplicate registration reaps the previous child. */
const DUP_REGISTRATION_KILL_REASON = 'dup-registration';
/** Grace before escalating that kill to SIGKILL, matching the sibling kill paths. */
const DUP_REGISTRATION_KILL_GRACE_MS = 2_000;

function registerActiveProcess(agentLabel: string, child: ChildProcess): void {
    const prev = activeProcesses.get(agentLabel);
    if (prev && prev !== child) {
        // `killed` only records that a signal was delivered, so it is not a
        // liveness test: a CLI that traps SIGTERM stays alive with killed set.
        // Treating it as exited would drop that survivor from the map without
        // even scheduling the escalation below — the exact invisible process
        // this branch exists to prevent.
        if (hasChildExited(prev)) {
            activeProcesses.delete(agentLabel);
        } else {
            // Dropping a live child from the map makes it invisible to
            // killAllAgents, so it survives stop, shutdown, and restart while
            // still holding its own memory. Reap it instead of leaking it.
            console.warn(`[spawn:dup] activeProcesses already has a live child for ${agentLabel} — killing it before overwrite (pid=${prev.pid ?? 'unknown'})`);
            if (prev.pid) {
                const prevPid = prev.pid;
                // Record a kill reason so the stale exit handler classifies this
                // as an intentional kill rather than a genuine agent error.
                killReasons.set(prevPid, DUP_REGISTRATION_KILL_REASON);
                try {
                    killProcessTree(prevPid, 'SIGTERM');
                } catch (error) {
                    console.warn(`[spawn:dup] failed to kill previous child for ${agentLabel}:`, (error as Error)?.message ?? error);
                }
                // Escalate like every sibling kill path does: a CLI that traps
                // SIGTERM would otherwise survive with no map entry to find it.
                // Route through killProcessTreeIfAlive so a child that exited
                // during the grace period cannot have its recycled PID killed:
                // killProcessTree walks `pgrep -P`, so a blind escalation would
                // take an unrelated process tree down with it.
                const escalate = setTimeout(() => {
                    killProcessTreeIfAlive(prev, prevPid);
                }, DUP_REGISTRATION_KILL_GRACE_MS);
                escalate.unref?.();
            }
        }
    }
    activeProcesses.set(agentLabel, child);
}

// Current Boss main session context — set when a mainManaged spawnAgent starts,
// cleared on exit. Used by dispatch routes to capture the original channel
// (web/telegram/discord + chatId) so that disconnected worker results can be
// replayed to the correct scope instead of defaulting to 'system'.
export interface MainSessionMeta {
    origin: string;
    target?: RemoteTarget;
    chatId?: string | number;
    requestId?: string;
    replyViaTarget?: boolean;
    scopeId?: string;
    chatSessionId?: string;
    remoteKey?: string;
    cli?: string;
    model?: string;
    effectiveProvider?: string;
    policyVerdicts?: PolicyVerdict[];
}

export type MainRunState = {
    process: ChildProcess | null;
    starting: boolean;
    steering: boolean;
    ownerGeneration: number;
    meta: MainSessionMeta;
    cancelPending?: (reason: string) => void;
    cancelTurn?: (reason: string) => void;
};

export const activeMainProcesses = new Map<string, MainRunState>();

export function getCurrentMainMeta(scopeKey?: string): MainSessionMeta | null {
    const scope = scopeKey ?? currentSessionScope()?.scope ?? 'default';
    return activeMainProcesses.get(scope)?.meta ?? null;
}

export function setCurrentMainMeta(scopeKey: string, meta: MainSessionMeta | null): void;
export function setCurrentMainMeta(meta: MainSessionMeta | null): void;
export function setCurrentMainMeta(scopeKeyOrMeta: string | MainSessionMeta | null, nextMeta?: MainSessionMeta | null): void {
    const scopeKey = typeof scopeKeyOrMeta === 'string'
        ? scopeKeyOrMeta
        : currentSessionScope()?.scope ?? 'default';
    const meta = typeof scopeKeyOrMeta === 'string' ? nextMeta ?? null : scopeKeyOrMeta;
    const run = activeMainProcesses.get(scopeKey);
    if (!meta) {
        activeMainProcesses.delete(scopeKey);
        return;
    }
    if (run) {
        run.meta = meta;
    } else {
        activeMainProcesses.set(scopeKey, {
            process: null,
            starting: false,
            steering: false,
            ownerGeneration: 0,
            meta,
        });
    }
}

export function releaseMainRun(
    scopeKey: string,
    child: ChildProcess | null,
    ownerGeneration: number,
): boolean {
    const run = activeMainProcesses.get(scopeKey);
    if (!run || run.process !== child || run.ownerGeneration !== ownerGeneration) return false;
    activeMainProcesses.delete(scopeKey);
    return true;
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
    last_run_clean?: number | null;
    last_run_cwd?: string | null;
    last_run_meta?: string | null;
}

type SpawnPromiseResult = {
    text: string;
    code: number;
    agyCheckpointSeen?: boolean;
    agyPlannerOnly?: boolean;
};

interface CopilotSpawnContext extends SpawnContext {
    thinkingBuf: string;
}

import { hasChildExited, killProcessTree, killProcessTreeIfAlive } from './spawn/process-kill.js';
import { releaseChildOutputAfterExit } from './spawn/exit-drain.js';
import { clampPendingLine } from './spawn/line-buffer.js';
import { appendBoundedFullText } from './events/fulltext-bound.js';

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
        emitAgentTool(ctx, agentLabel, tool, empTag);
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
                    killProcessTreeIfAlive(proc);
                } else if (proc.exitCode === null && proc.signalCode === null) {
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
    isSpawnBusy: (scopeKey) => isAgentBusy(scopeKey),
    hasBlockingWorkers,
    hasPendingWorkerReplays,
    insertMessage,
    getActiveChatSession,
    insertQueuedMessage,
    deleteQueuedMessage,
    listQueuedMessages: listQueuedMessages as unknown as { all(): Array<{ id: string; payload: string }> },
    migrateQueuedMessagesV1ToV2,
    broadcast,
    importPipeline: () => import('../orchestrator/pipeline.js'),
    getWorkingDir: () => settings["workingDir"] || null,
    isMultiSessionEnabled: () => settings["multiSession"]?.enabled === true,
    isLocalSessionScopeEnabled: () => LOCAL_SESSION_SCOPE_ACTIVATION,
});

export const {
    messageQueue,
    enqueueMessage,
    removeQueuedMessage,
    processQueue,
    setQueueHold,
    clearQueueHold,
    getQueueHoldId,
    isScopedQueue,
    isRetryPending,
    isQueueBusy,
    clearRetryTimer,
    // Exposed so DELETE's 409 paths can be driven end-to-end against the
    // production controller instead of an isolated instance.
    retryStateForScope,
    resetFallbackState,
    getFallbackState,
    getQueuedMessageSnapshotForScope,
    purgeQueueOnStop,
} = queueCtrl;

const piProfileFingerprintKey = crypto.randomBytes(32);

export function setSteerInProgress(scopeKey: string, value: boolean): void;
export function setSteerInProgress(value: boolean): void;
export function setSteerInProgress(scopeKeyOrValue: string | boolean, nextValue?: boolean): void {
    const scopeKey = typeof scopeKeyOrValue === 'string' ? scopeKeyOrValue : 'default';
    const value = typeof scopeKeyOrValue === 'boolean' ? scopeKeyOrValue : nextValue === true;
    const run = activeMainProcesses.get(scopeKey);
    if (!run) return;
    const was = run.steering;
    run.steering = value;
    if (was && !value) queueMicrotask(() => { void processQueue(scopeKey); });
}

export function isSteerInProgress(scopeKey = 'default'): boolean {
    return activeMainProcesses.get(scopeKey)?.steering === true;
}

export function isAgentBusy(scopeKey: string | null = 'default'): boolean {
    if (scopeKey === null) {
        return activeMainProcesses.size > 0
            || [...jawRuntimesByScope.values()].some(runtime => runtime.busy)
            || queueCtrl.isRetryPending(null);
    }
    return activeMainProcesses.has(scopeKey)
        || runtimeForScope(scopeKey).busy
        || queueCtrl.isRetryPending(scopeKey);
}

// ─── Kill / Steer ────────────────────────────────────

// [I2] Per-process kill reason map (replaces global variable to avoid cross-process confusion)
const killReasons = new Map<number, string>();
const DEFAULT_STEER_WAIT_MS = 3_000;
const DEFAULT_KILL_ESCALATION_MS = 2_000;
const CLAUDE_E_STEER_WAIT_MS = 30_000;
const CLAUDE_E_STEER_KILL_ESCALATION_MS = 8_000;
const DEFAULT_CODEX_APP_TURN_IDLE_MS = 300_000;
const DEFAULT_CODEX_APP_TURN_ABS_MS = 2 * 60 * 60_000;
const DEFAULT_CODEX_APP_ACQUIRE_WAIT_MS = 60_000;
const CODEX_APP_ACQUIRE_RETRY_BACKOFF_MAX_MS = 250;

function configuredPositiveMs(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getActiveMainCli(scopeKey: string): string | null {
    const cli = activeMainProcesses.get(scopeKey)?.meta.cli;
    return typeof cli === 'string' ? cli : null;
}

function isActiveAiEPtyRuntime(scopeKey: string): boolean {
    const cli = getActiveMainCli(scopeKey);
    return cli === 'claude-e' || cli === 'ai-e';
}

function getKillPolicy(scopeKey: string, reason: string): { signal: NodeJS.Signals; escalationMs: number } {
    if (reason === 'steer' && isActiveAiEPtyRuntime(scopeKey)) {
        return { signal: 'SIGINT', escalationMs: CLAUDE_E_STEER_KILL_ESCALATION_MS };
    }
    return { signal: 'SIGTERM', escalationMs: DEFAULT_KILL_ESCALATION_MS };
}

export function getSteerWaitMsForActiveAgent(scopeKey = 'default'): number {
    return isActiveAiEPtyRuntime(scopeKey) ? CLAUDE_E_STEER_WAIT_MS : DEFAULT_STEER_WAIT_MS;
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
 * 모두 폐기한다. exit handler의 scoped queue 자동 드레인이 stop 직후 잔존
 * 메시지를 "스스로 steer" 처럼 실행하던 회귀를 차단.
 */
/**
 * Fix C2: 사용자 stop 시 worker-registry 도 비운다.
 * gateway.submitMessage가 scoped main/worker/replay 상태를 모두 검사하므로,
 * 도 검사하므로, 이걸 비우지 않으면 stop 직후 새 메시지가 busy 분기 → 큐로 떨어지고
 * 프론트는 (1) 낙관 bubble + (2) applyQueuedOverlay 가 만든 queued bubble = 2개를 보여준다.
 */
function clearWorkerSlotsOnStop(scopeKey: string, reason: string) {
    const active = getActiveWorkers(scopeKey).length;
    if (active === 0 && !hasPendingWorkerReplays(scopeKey)) return;
    clearWorkersForScope(scopeKey);
    console.log(`[jaw:stop] cleared worker registry (active=${active}, scope=${scopeKey}, reason=${reason})`);
}

function clearMainLiveRunOnStop(scopeKey: string, reason: string): void {
    if (reason !== 'api' && reason !== 'user' && reason !== 'steer' && reason !== 'interrupt') return;
    clearLiveRun(scopeKey);
}

/**
 * jwc turns run in-process (no ChildProcess), so the SIGTERM/SIGKILL paths
 * below never touch them — abort the resident runtime session explicitly or
 * /api/stop is a no-op while jwc streams (devlog 260703 tui_steer_esc_rca).
 */
function abortInProcessRuntimeOnStop(scopeKey: string, reason: string): boolean {
    if (reason !== 'api' && reason !== 'user' && reason !== 'steer' && reason !== 'interrupt') return false;
    if (getActiveMainCli(scopeKey) !== 'jwc') return false;
    const runtime = runtimeForScope(scopeKey);
    if (!runtime.busy) return false;
    runtime.abort().catch((err: unknown) => {
        console.warn('[jaw:stop] jwc abort failed', (err as Error)?.message || err);
    });
    return true;
}

export function killActiveAgent(scopeKey: string, reason: string): boolean;
export function killActiveAgent(reason?: string): boolean;
export function killActiveAgent(scopeKeyOrReason = 'user', scopedReason?: string): boolean {
    const scopeKey = scopedReason === undefined ? 'default' : scopeKeyOrReason;
    const reason = scopedReason ?? scopeKeyOrReason;
    const run = activeMainProcesses.get(scopeKey);
    const hadTimer = queueCtrl.isRetryPending(scopeKey);
    const cancelledPendingMain = run?.cancelPending ? (run.cancelPending(reason), true) : false;
    clearRetryTimer(scopeKey, false);
    if (!cancelledPendingMain) clearMainLiveRunOnStop(scopeKey, reason);
    const abortedInProcess = abortInProcessRuntimeOnStop(scopeKey, reason);
    // Fix A: 사용자 stop은 큐도 폐기. steer/internal kill은 큐 보존.
    // Fix C2: worker registry 도 비워서 hasBlockingWorkers/hasPendingWorkerReplays가 즉시 false.
    if (reason === 'api' || reason === 'user') {
        queueCtrl.purgeQueueOnStop(scopeKey, reason);
        clearWorkerSlotsOnStop(scopeKey, reason);
    }
    if (run?.cancelTurn && (getActiveMainCli(scopeKey) === 'codex-app' || getActiveMainCli(scopeKey) === 'pi')) {
        if (run.process?.pid) killReasons.set(run.process.pid, reason);
        console.log(`[jaw:kill] reason=${reason} scope=${scopeKey} cli=${getActiveMainCli(scopeKey)} action=lease.cancel`);
        run.cancelTurn(reason);
        if (reason === 'api' || reason === 'user' || reason === 'steer' || reason === 'interrupt') activeMainProcesses.delete(scopeKey);
        return true;
    }
    const activeProcess = run?.process ?? null;
    if (!activeProcess) {
        if (reason === 'api' || reason === 'user' || reason === 'steer' || reason === 'interrupt') activeMainProcesses.delete(scopeKey);
        return hadTimer || cancelledPendingMain || abortedInProcess;
    }
    const policy = getKillPolicy(scopeKey, reason);
    console.log(`[jaw:kill] reason=${reason} scope=${scopeKey} cli=${getActiveMainCli(scopeKey) || 'unknown'} signal=${policy.signal} escalationMs=${policy.escalationMs}`);
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
    // Fix C1: 사용자 stop/steer 시 해당 scope busy가 즉시 false가 되도록 참조를 동기 해제.
    // 실제 child 종료는 위 setTimeout SIGKILL이 백그라운드에서 마무리.
    // exit handler의 setActiveProcess(null) / activeProcesses.delete 는 idempotent.
    if (reason === 'api' || reason === 'user' || reason === 'steer' || reason === 'interrupt') {
        activeMainProcesses.delete(scopeKey);
    }
    return true;
}

export function killAllAgents(reason = 'user') {
    const hadTimer = queueCtrl.isRetryPending(null);
    const mainScopes = [...activeMainProcesses.keys()];
    let killedMain = false;
    for (const scopeKey of mainScopes) {
        killedMain = killActiveAgent(scopeKey, reason) || killedMain;
    }
    if (reason === 'api' || reason === 'user') queueCtrl.purgeQueueOnStop(null, reason);
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
    if (reason === 'api' || reason === 'user') {
        activeProcesses.clear();
        activeMainProcesses.clear();
        clearAllWorkers();
    }
    return killed > 0 || killedMain || hadTimer;
}

export function waitForProcessEnd(scopeKey: string, timeoutMs?: number): Promise<void>;
export function waitForProcessEnd(timeoutMs?: number): Promise<void>;
export function waitForProcessEnd(scopeKeyOrTimeout: string | number = 'default', scopedTimeout = 3000) {
    const scopeKey = typeof scopeKeyOrTimeout === 'string' ? scopeKeyOrTimeout : 'default';
    const timeoutMs = typeof scopeKeyOrTimeout === 'number' ? scopeKeyOrTimeout : scopedTimeout;
    if (!activeMainProcesses.has(scopeKey)) return Promise.resolve();
    return new Promise<void>(resolve => {
        const check = setInterval(() => {
            if (!activeMainProcesses.has(scopeKey)) { clearInterval(check); resolve(); }
        }, 100);
        setTimeout(() => { clearInterval(check); resolve(); }, timeoutMs);
    });
}

export function canSteerAgent(scopeKey: string): boolean {
    const run = activeMainProcesses.get(scopeKey);
    return run?.meta.cli === 'jwc' && jawRuntimesByScope.get(scopeKey)?.busy === true;
}

export async function steerAgent(
    scopeKey: string,
    newPrompt: string,
    source: string,
    meta?: { chatSessionId?: string; target?: RemoteTarget; chatId?: string | number; requestId?: string; remoteKey?: string; replyViaTarget?: boolean },
) {
    const run = activeMainProcesses.get(scopeKey);
    const runtime = runtimeForScope(scopeKey);
    const chatSessionId = meta?.chatSessionId || run?.meta.chatSessionId || getActiveChatSession();
    if (run?.meta.cli === 'jwc' && runtime.busy) {
        insertMessage.run('user', newPrompt, source, '', settings["workingDir"] || null, chatSessionId);
        broadcast('new_message', { role: 'user', content: newPrompt, source, scope: scopeKey, sessionId: chatSessionId });
        broadcast('steer_started', stripUndefined({ prompt: newPrompt, origin: source || 'web', scope: scopeKey, sessionId: chatSessionId, target: meta?.target, chatId: meta?.chatId, requestId: meta?.requestId, remoteKey: meta?.remoteKey, replyViaTarget: meta?.replyViaTarget }));
        await runtime.steer(settings["workingDir"] || process.cwd(), newPrompt);
        return;
    }
    const steerWaitMs = getSteerWaitMsForActiveAgent(scopeKey);
    const wasRunning = killActiveAgent(scopeKey, 'steer');
    if (wasRunning) await waitForProcessEnd(scopeKey, steerWaitMs);
    insertMessage.run('user', newPrompt, source, '', settings["workingDir"] || null, chatSessionId);
    broadcast('new_message', { role: 'user', content: newPrompt, source, scope: scopeKey, sessionId: chatSessionId });
    broadcast('steer_started', { prompt: newPrompt, origin: source || 'web', scope: scopeKey });
    const { orchestrate, orchestrateContinue, orchestrateReset, isContinueIntent, isResetIntent } = await import('../orchestrator/pipeline.js');
    const origin = source || 'web';
    const task = isResetIntent(newPrompt)
        ? orchestrateReset({ origin, scope: scopeKey, chatSessionId, _skipInsert: true })
        : isContinueIntent(newPrompt)
            ? orchestrateContinue({ origin, scope: scopeKey, chatSessionId, _skipInsert: true })
            : orchestrate(newPrompt, { origin, scope: scopeKey, chatSessionId, _skipInsert: true });
    task.catch((err: Error) => {
        console.error('[steer:orchestrate]', err.message);
        broadcast('orchestrate_done', { text: `[error] ${err.message}`, error: true, origin });
    });
}


// ─── Helpers ─────────────────────────────────────────

function makeCleanEnv(extraEnv: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["CLAUDE_CODE_SSE_PORT"];
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

function buildHistoryBlock(currentPrompt: string, workingDir: string | null | undefined, chatSessionId: string, maxSessions = 10, maxTotalChars = 8000) {
    const recent = getRecentMessages.all(workingDir || null, chatSessionId, Math.max(1, maxSessions * 2)) as RecentMessageRow[];
    if (!recent.length) return '';

    const promptText = String(currentPrompt || '').trim();
    let skipCurrentPromptBudget = 2;
    const blocks = [];
    let charCount = 0;

    for (let i = 0; i < recent.length; i++) {
        const row = recent[i];
        if (!row) continue;
        if (row.cli === 'goal_boundary') break;
        // Goal-continuation boundary rows are chat-timeline markers only
        // (devlog 260705_web_live_update_boundary) — the actual continuation
        // prompt is injected at spawn, so replaying the marker is noise.
        if (row.cli === 'goal_continuation') continue;
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

// The session is passed in rather than read globally: the replay is prepended to THIS
// run's prompt, so it has to come from this run's conversation and not from whichever
// one happens to be active (073 §2.5a).
function getLatestAssistantContentForAgyResume(workingDir: string | null | undefined, chatSessionId: string): string | null {
    const rows = getRecentMessages.all(workingDir || null, chatSessionId, 12) as RecentMessageRow[];
    const row = rows.find((msg) => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0);
    return row?.content || null;
}

function getRecentAssistantContentsForAgyResume(workingDir: string | null | undefined, chatSessionId: string): string[] {
    const rows = getRecentMessages.all(workingDir || null, chatSessionId, 20) as RecentMessageRow[];
    return rows
        .filter((msg) => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim().length > 0)
        .map((msg) => String(msg.content || '').trim());
}

import { buildArgs, buildResumeArgs, formatAgyPrintTimeout, resolveAiEProvider, resolveScopedSessionBucket, resolveSessionBucket } from './args.js';
export { buildArgs, buildResumeArgs, resolveAiEProvider, resolveSessionBucket };

const warnedAgyCapabilityFallbacks = new Set<string>();

// ─── Upload wrapper ──────────────────────────────────

export const saveUpload = (buffer: Buffer | Uint8Array, originalName: string, options?: SaveUploadOptions) =>
    _saveUpload(UPLOADS_DIR, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), originalName, options);
export { buildMediaPrompt, buildMediaPromptMany };

// ─── Spawn Agent ─────────────────────────────────────

import { AcpClient } from '../cli/acp-client.js';
import { CodexAppClient, isRecoverableResumeError } from './codex-app-client.js';
import {
    acquireCodexAppRuntime,
    acquirePiRuntime,
    type PiLease,
} from './runtime-pool.js';
import {
    acquireCodexAppLane,
    CodexHostGenerationStaleError,
    prepareCodexAppHost,
} from './codex-host-pool.js';
import { loadCatalogEfforts, resolveCatalogPath, validateModelEffort } from './codex-app-catalog.js';
import {
    listenCodexAppTurnAdapter,
    type CodexAppEventResult,
} from './codex-app-events.js';

import { canGuardedAgyResume, resolveAgyNativeResume, shouldEmitHeartbeat, shouldResumeBucketSession } from './spawn/resume.js';
export { canGuardedAgyResume, resolveAgyNativeResume, shouldEmitHeartbeat, shouldResumeBucketSession };
import { createQueueController, FALLBACK_MAX_RETRIES } from './spawn/queue.js';
export type { QueueController } from './spawn/queue.js';


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
    _agyStaleFreshRetry?: boolean;
    forceNew?: boolean;
    agentId?: string;
    sysPrompt?: string;
    origin?: string;
    target?: RemoteTarget;
    requestId?: string;
    replyViaTarget?: boolean;
    employeeSessionId?: string;
    employeeOutputLen?: number;
    chatId?: string | number;
    scopeKey?: string;
    chatSessionId?: string;
    remoteKey?: string;
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
    const multiSessionEnabled = settings["multiSession"]?.enabled === true;
    const capturedScope = currentSessionScope();
    const scopeKey = multiSessionEnabled
        ? (opts.scopeKey || capturedScope?.scope || resolveOrcScope(stripUndefined({
            origin,
            target: opts.target,
            chatId: opts.chatId,
            workingDir: settings["workingDir"] || null,
            persistedScopeId: opts.remoteKey,
            multiSessionEnabled,
        })))
        : 'default';
    const chatSessionId = multiSessionEnabled
        ? (opts.chatSessionId || capturedScope?.chatSessionId || getActiveChatSession())
        : getActiveChatSession();
    if (multiSessionEnabled) {
        opts = stripUndefined({
            ...opts,
            scopeKey,
            chatSessionId,
            ...(opts.remoteKey ? { remoteKey: opts.remoteKey } : {}),
        });
    }

    let mainRun = mainManaged ? activeMainProcesses.get(scopeKey) : undefined;
    if (mainManaged && mainRun && !opts._settingsGateWaited) {
        console.log(`[jaw] Agent already running for scope=${scopeKey}, skipping`);
        return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
    }
    if (mainManaged && !mainRun) {
        mainRun = {
            process: null,
            starting: false,
            steering: false,
            ownerGeneration: 0,
            meta: { origin, scopeId: scopeKey, chatSessionId, ...(opts.remoteKey ? { remoteKey: opts.remoteKey } : {}) },
        };
        activeMainProcesses.set(scopeKey, mainRun);
    }

    if (gateEligibleMain && !opts._settingsGateWaited && isRuntimeSettingsMutationInFlight()) {
        if (queueCtrl.isRetryPending(scopeKey) || mainRun?.starting) {
            console.log('[jaw] Agent already running, skipping');
            return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
        }
        mainRun!.starting = true;
        let cancelled = false;
        let cancelReason = 'user';
        const cancelThisSpawn = (reason: string) => {
            cancelled = true;
            cancelReason = reason;
        };
        mainRun!.cancelPending = cancelThisSpawn;
        const promise: Promise<SpawnPromiseResult> = (async () => {
            try {
                await waitForRuntimeSettingsIdle();
                if (cancelled) {
                    return { text: `⏹️ [${cancelReason}]`, code: -1 };
                }
                const next: SpawnResult = spawnAgent(prompt, { ...opts, _settingsGateWaited: true });
                return await next.promise;
            } finally {
                const latest = activeMainProcesses.get(scopeKey);
                if (latest?.cancelPending === cancelThisSpawn) delete latest.cancelPending;
                if (latest) latest.starting = false;
                void processQueue(scopeKey);
            }
        })();
        return { child: null, promise };
    }

    // Ensure AGENTS.md on disk is fresh before CLI reads it
    // Skip for employee spawns — distribute.ts manages AGENTS.md isolation
    if (!opts.internal && !opts._isFallback && !opts.agentId) regenerateB();

    const liveScope = scopeKey;
    // Employee must not pollute boss's liveRun (see devlog 260423_employee_liverun_contamination)
    const effectiveLiveScope = mainManaged ? liveScope : null;

    // INVARIANT: 모든 외부 호출은 gateway.ts의 scoped busy admission을 거침.
    // 직접 spawnAgent 호출 시 scope별 retry state도 확인할 것.
    if (mainManaged && mainRun?.starting && gateEligibleMain && !opts._settingsGateWaited) {
        console.log('[jaw] Agent already running, skipping');
        return { child: null, promise: Promise.resolve({ text: '', code: -1 }) };
    }

    // Capture Boss main session channel so disconnected worker results can be
    // replayed to the correct origin/chatId later. Cleared in lifecycle-handler.
    if (mainManaged) {
        setCurrentMainMeta(scopeKey, stripUndefined({
            origin,
            target: opts.target,
            chatId: opts.chatId,
            requestId: opts.requestId,
            replyViaTarget: opts.replyViaTarget,
            scopeId: liveScope,
            chatSessionId,
            ...(opts.remoteKey ? { remoteKey: opts.remoteKey } : {}),
        }));
    }

    let resolve: (value: SpawnPromiseResult) => void;
    const resultPromise = new Promise<SpawnPromiseResult>(r => { resolve = r; });

    const session = (getSession() as SessionRow | undefined) ?? {};
    const persistenceOwner = getSessionOwnershipGeneration(scopeKey);
    const ownerGeneration = persistenceOwner.global;
    if (mainRun) mainRun.ownerGeneration = ownerGeneration;
    let cli = resolveMainCli(opts.cli, settings, session);
    if (mainRun) mainRun.meta.cli = cli;

    // Phase 52: Bootstrap consumption is moved BELOW the bucket-aware `isResume`
    // computation so we can use the authoritative per-bucket resume decision
    // instead of the legacy `isResumeGuess` heuristic. See comment near line 762.

    // ─── Fallback retry: skip to fallback if retries exhausted ───
    if (!opts._isFallback && !opts.internal) {
        const st = queueCtrl.fallbackStateForScope(scopeKey).get(cli);
        if (st?.fallbackCli && st.retriesLeft <= 0) {
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
    // so scoped busy/queue/SSE behave identically. Employees fall through.
    if (cli === 'jwc' && mainManaged && !opts.internal) {
        const jawRuntime = runtimeForScope(scopeKey);
        const jwcLabel = 'main';
        const jwcOverrides = settings["activeOverrides"]?.['jwc'] as Record<string, string> | undefined;
        const jwcPerCli = settings["perCli"]?.['jwc'] as Record<string, string> | undefined;
        const jwcModel = jwcOverrides?.['model'] || jwcPerCli?.['model'] || 'claude-fable-5';
        const jwcProvider = jwcOverrides?.['provider'] || jwcPerCli?.['provider'] || 'anthropic';
        const jwcCwd = settings["workingDir"] || process.cwd();
        if (!opts._skipInsert) {
            insertMessage.run('user', prompt, 'jwc', jwcModel, settings["workingDir"] || null, chatSessionId);
        }
        mainRun!.starting = true;
        beginLiveRun(liveScope, 'jwc');
        broadcast('agent_status', { running: true, agentId: jwcLabel, cli: 'jwc' });
        const jwcEffort = jwcOverrides?.['effort'] || jwcPerCli?.['effort'] || '';
        jawRuntime.setModelPattern(`${jwcProvider}/${jwcModel}`);
        jawRuntime.setThinkingLevel(jwcEffort || undefined);
        jawRuntime.setLiveScope(liveScope);
        const settleJwcTurn = (result: { text: string; code: number }): void => {
            const live = getLiveRun(liveScope);
            const rawFinalText = result.code === 0 ? live.text : result.text;
            const finalText = applyOutputPolicy(rawFinalText, { scope: 'main' }).text;
            // Persist may throw (better-sqlite3 is sync: DB lock / schema). Cleanup MUST
            // still run or this scope's starting flag stays true and its queue deadlocks.
            try {
                insertMessageWithTraceRun.run(
                    'assistant', finalText, 'jwc', jwcModel, null,
                    JSON.stringify(sanitizeToolLogForDurableStorage(live.toolLog)),
                    settings["workingDir"] || null, live.traceRunId || null, chatSessionId,
                );
                broadcast('agent_done', { text: finalText, origin, ...(result.code === 0 ? {} : { error: true }) });
            } catch (err) {
                console.error('[jwc:persist]', err instanceof Error ? err.message : String(err));
                broadcast('agent_done', { text: finalText, origin, error: true });
            } finally {
                clearLiveRun(liveScope);
                broadcast('agent_status', { running: false, agentId: jwcLabel, cli: 'jwc' });
                mainRun!.starting = false;
                jawRuntime.setLiveScope(undefined);
                releaseMainRun(scopeKey, null, ownerGeneration);
                resolve!({ text: finalText, code: result.code });
                void processQueue(scopeKey);
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
    const codexMultiplexMain = cli === 'codex-app' && mainManaged && !opts.agentId
        && settings["runtime"]?.codexApp?.multiplex === true;
    if (mainManaged) {
        setCurrentMainMeta(scopeKey, stripUndefined({
            origin,
            target: opts.target,
            chatId: opts.chatId,
            requestId: opts.requestId,
            replyViaTarget: opts.replyViaTarget,
            scopeId: liveScope,
            chatSessionId,
            ...(opts.remoteKey ? { remoteKey: opts.remoteKey } : {}),
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
    // Every runtime now keys its bucket by scope (073 §2.1), which replaces the guard 072
    // put here. That guard gave a non-default scope no bucket at all — no resume, no
    // snapshot, no stale clear — because sharing one was worse. Having its own is better
    // than either. The default scope keeps the bare bucket name, so a session that existed
    // before this change continues the conversation it was already in.
    const currentBucket = resolveScopedSessionBucket(
        cli, runtimeModel, effectiveProvider, scopeKey, effort, 'fallback', codexMultiplexMain,
    );
    const envDefaultsCli = cli === 'ai-e' ? effectiveProvider : cli;
    const cliEnv = applyCliEnvDefaults(envDefaultsCli, opts.env);
    const spawnEnv = makeCleanEnv(cliEnv);
    const bucketRow = currentBucket ? getSessionBucket.get(currentBucket) as SessionBucketRow | undefined : null;
    const bucketSessionId = bucketRow?.session_id || null;
    const bucketModel = typeof bucketRow?.model === 'string' ? bucketRow.model : null;
    const bucketResumeKey = typeof bucketRow?.resume_key === 'string' ? bucketRow.resume_key : null;
    const bucketUpdatedAt = bucketRow?.updated_at ?? null;
    const resumeKey = buildSessionResumeKey(cli, spawnEnv);
    const agyBinaryForCapabilities = cli === 'agy' ? (detectCli('agy').path || 'agy') : null;
    const earlyAgyCapabilities = agyBinaryForCapabilities ? detectAgyCapabilities(agyBinaryForCapabilities) : undefined;
    const agyResumeDecision = canGuardedAgyResume({
        mode: resolveAgyNativeResume(cfg.nativeResume),
        conversationSupported: earlyAgyCapabilities?.conversation === true,
        sessionId: bucketSessionId, bucketUpdatedAt, requestedModel: runtimeModel, bucketModel,
        cwd: settings['workingDir'] || '', lastRunCwd: bucketRow?.last_run_cwd,
        lastRunClean: bucketRow?.last_run_clean, lastRunMeta: bucketRow?.last_run_meta,
        freshBootstrap: forceNew || opts._skipResume === true || Boolean(peekPendingBootstrapPrompt(scopeKey)),
    });
    if (cli === 'agy') console.log(`[agy-resume] ${agyResumeDecision.ok ? 'resume' : 'fresh'} reason=${agyResumeDecision.reason}`);
    // AGY native resume can replay prior stdout and continue stale mid-turn planner
    // state. cli-jaw defaults to DB history; guarded native resume is explicit opt-in.
    const providerSupportsResume = cli !== 'agy'
        ? !(cli === 'ai-e' && effectiveProvider !== 'claude' && effectiveProvider !== 'kiro' && effectiveProvider !== 'codex' && effectiveProvider !== 'grok')
        : agyResumeDecision.ok;
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
    if (!opts.agentId && !opts.internal && !isResume) {
        const pending = consumePendingBootstrapPrompt(scopeKey);
        if (pending) {
            console.log(`[jaw:compact] injecting bootstrap (${pending.length} chars)`);
            prompt = `${pending}\n\n---\n\n${prompt}`;
        }
    }

    if (!empSid && !forceNew && bucketSessionId && !canResumeBucketSession) {
        if (!peekPendingBootstrapPrompt(scopeKey)) {
            import('../core/compact.js')
                .then(({ autoCompactRefresh }) => autoCompactRefresh({
                    workDir: settings["workingDir"] || null, instructions: '', cli, model: runtimeModel, scopeKey,
                    chatSessionId,
                    ...(currentBucket ? { sessionBucket: currentBucket } : {}),
                }))
                .catch(() => {});
        }
        try {
            if (currentBucket) clearSessionBucket.run(currentBucket);
        } catch (e) {
            console.warn('[jaw:resume] stale bucket clear failed:', (e as Error).message);
        }
        if (cli === 'opencode' && resumeKey !== (bucketResumeKey ?? null)) {
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
        : getSystemPrompt(stripUndefined({ currentPrompt: promptForSnapshot, forDisk: false, memorySnapshot: memorySnapshotForPrompt, activeCli: cli, freshSession: !isResume }));

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
    const needsHistory = shouldBuildHistoryBlock({
        skipHistory: opts._skipHistory === true,
        isResume,
        cli,
        codexMultiplexMain,
    });
    const historyBlock = needsHistory
        ? buildHistoryBlock(
            prompt,
            settings["workingDir"],
            chatSessionId,
            10,
            8000,
        )
        : '';
    let agyBootstrap: AgyBootstrapEnvelope | null = null;
    let promptForArgs = buildPromptForArgs({
        cli,
        effectiveProvider,
        prompt,
        historyBlock,
        sysPrompt,
        isResume,
    });
    const agyResumeReplayPrefix = cli === 'agy' && isResume
        ? getLatestAssistantContentForAgyResume(settings["workingDir"], chatSessionId)
        : null;
    const agyResumeReplayPrefixes = cli === 'agy' && isResume
        ? getRecentAssistantContentsForAgyResume(settings["workingDir"], chatSessionId)
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
    const agyCapabilities = earlyAgyCapabilities;
    if (agyCapabilities?.usedFallback && agyBinaryForCapabilities && !warnedAgyCapabilityFallbacks.has(agyBinaryForCapabilities)) {
        warnedAgyCapabilityFallbacks.add(agyBinaryForCapabilities);
        console.warn('[agy-capabilities] probe failed; using legacy emit-all argv compatibility');
    }
    let argOptions = {
        fastMode: cfg.fastMode,
        sysPrompt,
        includeDirectories,
        workingDir: settings["workingDir"],
        aiEProvider: effectiveProvider,
        ...(claudeBin ? { claudeBin } : {}),
        ...(agyLogFile ? { agyLogFile } : {}),
        ...(agyPrintTimeout ? { agyPrintTimeout } : {}),
        ...(agyCapabilities ? { agyCapabilities } : {}),
    };
    const buildCurrentArgs = (options: typeof argOptions): string[] => {
        if (!isResume) {
            return buildArgs(cli, runtimeModel, effort, promptForArgs, sysPrompt, permissions, options);
        }
        const sid = resumeSessionId || '';
        console.log(`[jaw:resume] ${cli} session=${sid.slice(0, 12)}...`);
        return buildResumeArgs(cli, runtimeModel, effort, sid, promptForArgs, permissions, options);
    };
    let args: string[] = [];
    if (cli !== 'agy') args = buildCurrentArgs(argOptions);

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

    if (cli === 'agy') {
        agyBootstrap = buildAgyBootstrapEnvelope({
            taskPrompt: prompt,
            historyBlock,
            workingDir: spawnCwd,
            sessionId: resumeSessionId,
            order: resolveAgyPromptOrder(cfg.promptOrder),
            ...(sysPrompt ? { operationalContext: sysPrompt } : {}),
        });
        promptForArgs = agyBootstrap.prompt;
        argOptions = { ...argOptions, workingDir: spawnCwd };
        args = buildCurrentArgs(argOptions);
    }

    const policyVerdicts = runBeforeSpawnChecks({
        cli,
        promptChars: promptForArgs.length + (sysPrompt?.length || 0),
        prompt: `${sysPrompt || ''}\n${promptForArgs}`,
    });
    if (policyVerdicts.length && mainRun) mainRun.meta.policyVerdicts = policyVerdicts;

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
        if (mainManaged) {
            releaseMainRun(scopeKey, null, ownerGeneration);
            void processQueue(scopeKey);
        }
        cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
        return { child: null, promise: resultPromise };
    }

    if (cli === 'copilot') {
        console.log(`[jaw:${agentLabel}] Spawning: copilot --acp --model ${model} [${permissions}]`);
    } else {
        console.log(`[jaw:${agentLabel}] Spawning: ${cli} ${args.join(' ').slice(0, 120)}...`);
        if (cli === 'claude-e') console.log(`[jaw:${agentLabel}:args] ${JSON.stringify(args)}`);
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
        if (mainManaged) mainRun!.process = child;
        else registerActiveProcess(agentLabel, child);
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
            if (mainManaged) {
                releaseMainRun(scopeKey, child, ownerGeneration);
                clearLiveRun(liveScope);
                broadcast('agent_status', { running: false, agentId: agentLabel });
            } else {
                activeProcesses.delete(agentLabel);
            }
            broadcast('agent_done', { text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
            resolve!({ text: '', code: 1 });
            if (mainManaged) void processQueue(scopeKey);
        });

        if (mainManaged && !opts.internal && !opts._skipInsert) {
            insertMessage.run('user', prompt, cli, model, settings["workingDir"] || null, chatSessionId);
        }
        if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag }, traceAudience);

        if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);
        const traceRunId = startTraceRun({ cli, model, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience });
        if (mainManaged && !opts.internal) setLiveRunTraceId(liveScope, traceRunId);
        const ctx: CopilotSpawnContext = {
            fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set<string>(),
            hasClaudeStreamEvents: false, sessionId: null as string | null, cost: null as number | null,
            turns: null as number | null, duration: null as number | null, tokens: null, stderrBuf: '',
            thinkingBuf: '',
            runStartedAt: Date.now(),
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
                emitAgentTool(ctx, agentLabel, tool, empTag);
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
                    emitAgentTool(ctx, agentLabel, parsedTool, empTag);
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
                emitAgentTool(ctx, agentLabel, parsed.tool, empTag);
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
                emitAgentTool(ctx, agentLabel, parsed.tool, empTag);
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
                emitAgentTool(ctx, agentLabel, {
                    icon: '⏳',
                    label: 'working... (no visible progress)',
                }, empTag);
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
                const fallbackHistory = needsHistoryFallback && !opts._skipHistory ? buildHistoryBlock(prompt, settings["workingDir"], chatSessionId) : '';
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
                    persistenceOwner,
                    scopeKey,
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
                prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
                isResume, wasKilled, wasSteer, smokeResult,
                effortDefault: '', costLine: '',
                resolve: resolve!,
                activeProcesses,
                scopeKey,
                scopedBucket: currentBucket,
                chatSessionId,
                childProcess: child,
                releaseMainRun,
                retryState: queueCtrl.retryStateForScope(scopeKey),
                fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
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
            runStartedAt: Date.now(),
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
                emitAgentTool(ctx, agentLabel, tool, empTag);
            }
            ctx.thinkingBuf = '';
        }
        const piToolDiscipline = [
            '[Pi Tool Discipline]',
            'Your available tools are strictly lowercase: read, bash, edit, write, grep, find, ls.',
            'Capitalized variants (Read, Bash, Edit, Write, Grep, Find, Ls) do NOT exist and will fail.',
        ].join('\n');
        const piSysPrompt = sysPrompt ? `${sysPrompt}\n\n${piToolDiscipline}` : piToolDiscipline;
        const onPiEvent = (event: import('./pi-runtime.js').PiRuntimeEvent) => {
            opts.lifecycle?.onActivity?.('pi-rpc');
            if (event.kind === 'thinking') {
                ctx.thinkingBuf = (ctx.thinkingBuf || '') + event.text;
                return;
            }
            if (event.kind === 'text') {
                flushPiThinking();
                const delta = String(event.text || '');
                if (!delta) return;
                {
                    // D3: bound fullText — see events/fulltext-bound.ts.
                    const bounded = appendBoundedFullText(ctx.fullText, delta);
                    ctx.fullText = bounded.text;
                    if (bounded.truncated) ctx.fullTextTruncated = true;
                }
                const displayDelta = normalizeAssistantDisplayText(delta);
                if (ctx.liveOutputText !== undefined) {
                    // Bound this too: it is promoted into fullText at close.
                    const live = appendBoundedFullText(ctx.liveOutputText, displayDelta);
                    ctx.liveOutputText = live.text;
                    if (live.truncated) ctx.fullTextTruncated = true;
                }
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
                emitAgentTool(ctx, agentLabel, tool, empTag);
                return;
            }
            if (event.kind === 'session') ctx.sessionId = event.sessionId;
        };
        type PiTurnResult = { text: string; stderr: string; code: number; sessionId?: string | null };
        const runPiTurn = (child: ChildProcess, done: Promise<PiTurnResult>, lease: PiLease | null): void => {
            let leaseCancel: Promise<void> | null = null;
            const requestCancel = (): Promise<void> => {
                if (!lease) {
                    if (child.pid) {
                        const pid = child.pid;
                        killProcessTree(pid, 'SIGTERM');
                        setTimeout(() => {
                            killProcessTreeIfAlive(child, pid);
                        }, 5_000);
                    } else child.kill('SIGTERM');
                    return Promise.resolve();
                }
                leaseCancel ??= lease.cancel();
                return leaseCancel;
            };
            const cancelHook = (_reason: string) => { void requestCancel(); };
            if (lease && mainRun) mainRun.cancelTurn = cancelHook;
            const piWatchdog = attachWatchdog(child, agentLabel, (reason) => {
                console.log(`[jaw:watchdog] cancelling ${agentLabel} (pi) — ${reason}`);
                ctx.stallReason = reason;
                void requestCancel();
            });
            ctx.stallWatchdog = piWatchdog;

            if (mainManaged) mainRun!.process = child;
            else registerActiveProcess(agentLabel, child);
            if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, provider: profile.id, ...empTag });
            if (mainManaged && !opts.internal) {
                beginLiveRun(liveScope, cli);
                setLiveRunTraceId(liveScope, traceRunId);
            }
            if (mainManaged && !opts.internal && !opts._skipInsert) {
                insertMessage.run('user', prompt, cli, runtimeModel, settings["workingDir"] || null, chatSessionId);
            }
            if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, provider: profile.id, ...empTag }, traceAudience);

            const releaseLease = async (): Promise<void> => {
                if (leaseCancel) await leaseCancel;
                if (mainRun?.cancelTurn === cancelHook) delete mainRun.cancelTurn;
                if (lease) lease.release();
                else cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
            };
            done.then(async (result) => {
                piWatchdog.stop();
                await releaseLease();
                flushPiThinking();
                if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += result.stderr || '';
                if (result.sessionId) ctx.sessionId = result.sessionId;
                if (!ctx.fullText && result.text) ctx.fullText = result.text;
                opts.lifecycle?.onExit?.(result.code);
                const killReason = consumeKillReason(child.pid);
                const wasKilled = !!killReason;
                // 'dup-registration' behaves like a steer for cleanup purposes: a
                // replacement child already owns this label, so the stale exit handler
                // must not delete the new child's map entry.
                const wasSteer = killReason === 'steer' || killReason === DUP_REGISTRATION_KILL_REASON;
                const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, result.code, cli);
                return handleAgentExit({
                    ctx, code: result.code, cli, model: runtimeModel, effectiveProvider: profile.id, agentLabel, mainManaged, origin,
                    resumeKey,
                    prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
                    isResume: false, wasKilled, wasSteer, smokeResult,
                    effortDefault: 'medium', costLine: '',
                    resolve: resolve!,
                    activeProcesses,
                    scopeKey,
                    scopedBucket: currentBucket,
                    chatSessionId,
                    childProcess: child,
                    releaseMainRun,
                    retryState: queueCtrl.retryStateForScope(scopeKey),
                    fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
                    fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                    processQueue,
                });
            }).catch(async (err: Error) => {
                piWatchdog.stop();
                await releaseLease().catch(() => {});
                if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += err.message;
                console.error('[jaw:pi] runtime failed:', err.message);
                handleAgentExit({
                    ctx, code: 1, cli, model: runtimeModel, effectiveProvider: profile.id, agentLabel, mainManaged, origin,
                    resumeKey,
                    prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
                    isResume: false, wasKilled: false, wasSteer: false, smokeResult: detectSmokeResponse('', [], 1, cli),
                    effortDefault: 'medium', costLine: '',
                    resolve: resolve!,
                    activeProcesses,
                    scopeKey,
                    scopedBucket: currentBucket,
                    chatSessionId,
                    childProcess: child,
                    releaseMainRun,
                    retryState: queueCtrl.retryStateForScope(scopeKey),
                    fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
                    fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                    processQueue,
                }).catch((handleErr: Error) => {
                    console.error('[jaw:lifecycle] handleAgentExit failed (Pi):', handleErr.message);
                });
            });
        };

        if (opts.agentId) {
            const { child, done } = spawnPiRpc(profile, pi, {
                prompt: piPrompt,
                model: runtimeModel,
                ...(piSessionId ? { sessionId: piSessionId } : {}),
                effort,
                cwd: spawnCwd,
                sysPrompt: piSysPrompt,
                onEvent: onPiEvent,
            });
            runPiTurn(child, done, null);
            return { child, promise: resultPromise };
        }

        const profileFp = crypto.createHmac('sha256', piProfileFingerprintKey)
            .update(profile.apiKey || '')
            .digest('hex')
            .slice(0, 12);
        mainRun!.starting = true;
        void acquirePiRuntime({
            key: {
                scopeKey,
                cwd: spawnCwd,
                profileId: profile.id,
                fullEndpoint: profile.endpoint,
                apiKind: profile.apiKind,
                model: runtimeModel,
                effort,
                profileFp,
            },
            piSettings: pi,
            storedSessionId: piSessionId || null,
            instructions: piSysPrompt,
            forceNew,
        }).then((lease) => {
            mainRun!.starting = false;
            ctx.sessionId = lease.session.sessionId;
            console.log(`[jaw:pi:pool] reused=${lease.reused} sessionId=${lease.session.sessionId || 'new'}`);
            const done = lease.session.sendPrompt(piPrompt, { effort, onEvent: onPiEvent })
                .then((result): PiTurnResult => ({ ...result, code: 0, sessionId: lease.session.sessionId }));
            runPiTurn(lease.session.child, done, lease);
        }).catch((err: Error) => {
            mainRun!.starting = false;
            console.error(`[jaw:pi:pool] acquire failed: ${err.message}`);
            clearLiveRun(liveScope);
            broadcast('agent_status', { running: false, agentId: agentLabel });
            broadcast('agent_done', { text: `❌ Pi RPC acquire failed: ${err.message}`, error: true, origin }, 'public');
            releaseMainRun(scopeKey, null, ownerGeneration);
            resolve!({ text: '', code: 1 });
            void processQueue(scopeKey);
        });
        return { child: null, promise: resultPromise };
    }

    // ─── Codex AppServer branch ────────────────────
    if (cli === 'codex-app') {
        const catalogPath = resolveCatalogPath();
        if (catalogPath) {
            const verdict = validateModelEffort(model, effort, loadCatalogEfforts(catalogPath));
            if (!verdict.ok) {
                throw new Error(`[codex-app] ${verdict.error}`);
            }
        }
        if (mainManaged && !opts.internal && !opts._skipInsert) {
            insertMessage.run('user', prompt, cli, model, settings["workingDir"] || null, chatSessionId);
        }
        if (!opts.internal) broadcast('agent_status', { status: 'running', cli, agentId: agentLabel, ...empTag }, traceAudience);

        const traceRunId = startTraceRun({ cli, model, workingDir: settings["workingDir"] || null, agentLabel, audience: traceAudience });
        if (mainManaged && !opts.internal) setLiveRunTraceId(liveScope, traceRunId);
        const ctx: CopilotSpawnContext = {
            fullText: '', traceLog: [], toolLog: [], seenToolKeys: new Set<string>(),
            hasClaudeStreamEvents: false, sessionId: null as string | null, cost: null as number | null,
            turns: null as number | null, duration: null as number | null, tokens: null, stderrBuf: '',
            thinkingBuf: '',
            runStartedAt: Date.now(),
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
                emitAgentTool(ctx, agentLabel, tool, empTag);
            }
            ctx.thinkingBuf = '';
        }

        let lastVisibleBroadcastTs = Date.now();
        let heartbeatSent = false;

        let turnCompleted = false;
        let turnReportedFailure = false;
        let markCodexProgress = () => {};
        let settleTurn!: () => void;
        let rejectTurn!: (err: Error) => void;
        const turnDone = new Promise<void>((resolveTurn, rejectTurnPromise) => {
            settleTurn = resolveTurn;
            rejectTurn = rejectTurnPromise;
        });

        const consumeCodexAppEvent = (method: string, parsed: CodexAppEventResult | null) => {
            if (!parsed) {
                if (method === 'turn/completed') settleTurn();
                return;
            }

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
                    emitAgentTool(ctx, agentLabel, parsedTool, empTag);
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
                turnReportedFailure = true;
            }
            opts.lifecycle?.onActivity?.('codex-app');
            if (method === 'turn/completed') settleTurn();
        };

        const handleStderr = (text: string) => {
            appendTraceEvent({ runId: ctx.traceRunId, source: 'stderr', eventType: 'stderr', raw: text });
            if (ctx.stderrBuf.length < 4000) {
                ctx.stderrBuf += text + '\n';
            }
            opts.lifecycle?.onActivity?.('stderr');
            if (shouldEmitHeartbeat(lastVisibleBroadcastTs, heartbeatSent)) {
                heartbeatSent = true;
                const elapsed = Math.round((Date.now() - lastVisibleBroadcastTs) / 1000);
                console.log(`  ⏳ agent active (no visible event for ${elapsed}s)`);
                emitAgentTool(ctx, agentLabel, {
                    icon: '⏳',
                    label: 'working... (no visible progress)',
                }, empTag);
            }
        };

        const effectiveFastMode = cfg.fastMode ?? settings["perCli"]?.["codex"]?.fastMode ?? false;

        type CodexAppTurnLeaseView = {
            readonly threadId: string;
            readonly reused: boolean;
            readonly resumedThread: boolean;
            readonly bucketKey?: string;
            readonly laneScope: string;
            release(): void;
            cancel(): Promise<void>;
        };
        const runCodexAppTurn = async (
            appClient: CodexAppClient,
            lease: CodexAppTurnLeaseView | null,
            laneScope: string,
        ): Promise<void> => {
            const child = appClient.proc;
            if (!child) throw new Error('Codex AppServer process was not created');
            if (mainManaged) mainRun!.process = child;
            else registerActiveProcess(agentLabel, child);
            if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...empTag });

            const processExit: { value: { code: number | null; signal: string | null } | null } = { value: null };
            const idleMs = configuredPositiveMs(process.env["CODEX_APP_TURN_IDLE_MS"], DEFAULT_CODEX_APP_TURN_IDLE_MS);
            const absoluteMs = configuredPositiveMs(process.env["CODEX_APP_TURN_ABS_MS"], DEFAULT_CODEX_APP_TURN_ABS_MS);
            let idleTimer: NodeJS.Timeout;
            let absoluteTimer: NodeJS.Timeout;
            let watchdogCancel: Promise<void> | null = null;
            let leaseCancel: Promise<void> | null = null;
            const requestLeaseCancel = (): Promise<void> => {
                if (!lease) {
                    appClient.kill();
                    return Promise.resolve();
                }
                leaseCancel ??= lease.cancel().catch((err: unknown) => {
                    console.warn('[codex-app:turn] cancel failed:', (err as Error).message);
                });
                return leaseCancel;
            };
            const cancelHook = (_reason: string) => { void requestLeaseCancel(); };
            if (lease && mainRun) mainRun.cancelTurn = cancelHook;
            const watchdogTimeout = (kind: 'idle' | 'absolute') => {
                if (watchdogCancel) return;
                console.warn(`[codex-app:turn] watchdog stall (${kind}, idleMs=${idleMs}, absoluteMs=${absoluteMs})`);
                watchdogCancel = requestLeaseCancel();
                rejectTurn(new Error(`Codex AppServer turn ${kind} watchdog timeout`));
            };
            const resetIdleTimer = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => { watchdogTimeout('idle'); }, idleMs);
            };
            idleTimer = setTimeout(() => { watchdogTimeout('idle'); }, idleMs);
            absoluteTimer = setTimeout(() => { watchdogTimeout('absolute'); }, absoluteMs);
            markCodexProgress = resetIdleTimer;
            const listener = listenCodexAppTurnAdapter(appClient, lease, laneScope, ctx, {
                onProgress: () => { markCodexProgress(); },
                onRawNotification: (method, params) => {
                    if (method === 'turn/completed' || method === 'turn/started' || method === 'error') {
                        console.log(`[codex-app:notify] ${method}`);
                    }
                    appendTraceEvent({ runId: ctx.traceRunId, source: 'codex_app_raw', eventType: method, raw: params });
                },
                onDiagnosticNotification: (entry) => {
                    appendTraceEvent({
                        runId: ctx.traceRunId,
                        source: 'codex_app_raw',
                        eventType: 'unrouted-notification',
                        raw: entry,
                    });
                },
                onEvent: consumeCodexAppEvent,
                onStderr: handleStderr,
                onExit: (code, signal) => {
                    processExit.value = { code, signal };
                    rejectTurn(new Error(`Codex AppServer exited (code=${code}, signal=${signal})`));
                },
                onError: rejectTurn,
                onInterruptFailed: (err) => {
                    console.warn(`[codex-app:interrupt] ${err.message}`);
                },
            });

            try {
                if (lease) {
                    ctx.sessionId = lease.threadId;
                    console.log(`[codex-app:pool] thread=${lease.threadId.slice(0, 12)}... reused=${lease.reused} resumed=${lease.resumedThread}`);
                } else {
                    const initResult = await appClient.initialize();
                    if (process.env["DEBUG"]) console.log('[codex-app:init]', JSON.stringify(initResult).slice(0, 200));
                    const threadOptions = {
                        model,
                        effort,
                        cwd: spawnCwd,
                        fastMode: effectiveFastMode,
                        instructions: sysPrompt,
                    };

                    if (isResume && resumeSessionId) {
                        try {
                            await appClient.resumeThread(laneScope, resumeSessionId, threadOptions);
                            console.log(`[codex-app:session] resumeThread OK: ${resumeSessionId.slice(0, 12)}...`);
                        } catch (resumeErr: unknown) {
                            const message = (resumeErr as Error).message || '';
                            if (!isRecoverableResumeError(message)) throw resumeErr;
                            console.warn(`[codex-app:session] resumeThread FAILED (recoverable): ${message} — starting new thread`);
                            if (empSid && opts.agentId) clearEmployeeSession.run(opts.agentId);
                            await appClient.startThread(laneScope, threadOptions);
                        }
                    } else {
                        await appClient.startThread(laneScope, threadOptions);
                    }
                    ctx.sessionId = appClient.getThreadId(laneScope) ?? '';
                }

                const shouldPrependHistory = lease
                    ? !(lease.resumedThread || lease.reused)
                    : !(isResume && Boolean(resumeSessionId));
                const codexAppPrompt = (shouldPrependHistory && historyBlock)
                    ? `${historyBlock}\n\n[User Message]\n${prompt}`
                    : prompt;

                const startTurn = appClient.startTurn(laneScope, codexAppPrompt);
                await Promise.race([startTurn, turnDone]);
                await turnDone;
                turnCompleted = !turnReportedFailure;

                flushCodexAppThinking();

                const persistedThreadId = lease?.threadId ?? appClient.getThreadId(laneScope);
                if (persistedThreadId && persistMainSession(stripUndefined({
                    persistenceOwner,
                    scopeKey,
                    forceNew,
                    employeeSessionId: empSid,
                    sessionId: persistedThreadId,
                    isFallback: opts._isFallback,
                    cli,
                    model,
                    resumeKey,
                    effort: cfg.effort || '',
                    skipSessionPersist: opts._skipSessionPersist === true,
                    ...(lease?.bucketKey ? { codexAppBucket: lease.bucketKey } : {}),
                }))) {
                    console.log(`[jaw:session] saved ${cli} session=${persistedThreadId.slice(0, 12)}... (pre-shutdown)`);
                }
            } catch (err: unknown) {
                console.error(`[codex-app:error] ${(err as Error).message}`);
                if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += (err as Error).message;
                if (!lease) appClient.kill();
            } finally {
                clearTimeout(idleTimer);
                clearTimeout(absoluteTimer);
                markCodexProgress = () => {};
                if (watchdogCancel) await watchdogCancel;
                if (mainRun?.cancelTurn === cancelHook) delete mainRun.cancelTurn;
                listener.dispose();
                if (lease) lease.release();
                else {
                    await appClient.closeGracefully();
                    appClient.cleanup();
                    cleanupEmployeeTmpDir(spawnCwd, settings["workingDir"], agentLabel);
                }
            }

            // A turn that never completed is a failure even when the process it
            // was running on exited cleanly. Trusting the child's status here
            // reports success for a turn that produced nothing, which is exactly
            // what happens when a shared host is closed mid-turn.
            const exitCode = turnCompleted ? 0 : (processExit.value?.code || 1);
            opts.lifecycle?.onExit?.(exitCode);
            const killReason = consumeKillReason(child.pid);
            if (processExit.value && processExit.value.code !== 0 && !killReason) {
                console.warn(`[codex-app:unexpected-exit] code=${processExit.value.code} signal=${processExit.value.signal} threadId=${ctx.sessionId || 'none'}`);
            }
            const wasKilled = !!killReason;
            // See above: a dup-registration kill must not clobber the replacement.
            const wasSteer = killReason === 'steer' || killReason === DUP_REGISTRATION_KILL_REASON;
            flushCodexAppThinking();
            const smokeResult = detectSmokeResponse(ctx.fullText, ctx.toolLog, exitCode, cli);
            await handleAgentExit({
                ctx, code: exitCode, cli, model, agentLabel, mainManaged, origin,
                resumeKey,
                prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
                isResume, wasKilled, wasSteer, smokeResult,
                effortDefault: '', costLine: '',
                resolve: resolve!,
                activeProcesses,
                scopeKey,
                scopedBucket: currentBucket,
                chatSessionId,
                ...(lease?.bucketKey ? { codexAppBucket: lease.bucketKey } : {}),
                childProcess: child,
                releaseMainRun,
                retryState: queueCtrl.retryStateForScope(scopeKey),
                fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
                fallbackMaxRetries: FALLBACK_MAX_RETRIES,
                processQueue,
            }).catch((err: Error) => {
                console.error('[jaw:lifecycle] handleAgentExit failed (codex-app):', err.message);
            });
        };

        if (opts.agentId) {
            const employeeLaneScope = `employee:${opts.agentId}`;
            const appClient = new CodexAppClient({
                binary: detected.path || 'codex', workDir: spawnCwd, env: spawnEnv,
            });
            appClient.spawn();
            const child = appClient.proc;
            if (!child) throw new Error('Codex AppServer process was not created');
            void runCodexAppTurn(appClient, null, employeeLaneScope);
            return { child, promise: resultPromise };
        }

        type CodexAppAcquiredLease = CodexAppTurnLeaseView & { readonly client: CodexAppClient };
        type CodexAppAcquireOutcome =
            | { kind: 'lease'; lease: CodexAppAcquiredLease }
            | { kind: 'cancelled'; reason: string };

        mainRun!.starting = true;
        const acquireCodexAppForTurn = async (): Promise<CodexAppAcquireOutcome> => {
            let cancelled = false;
            let cancelReason = 'user';
            const cancelThisAcquire = (reason: string) => {
                cancelled = true;
                cancelReason = reason;
            };
            const acquireWasCancelled = () => cancelled || activeMainProcesses.get(scopeKey) !== mainRun;

            try {
                if (!codexMultiplexMain) {
                    const lease = await acquireCodexAppRuntime({
                        binary: detected.path || 'codex', env: spawnEnv,
                        route: 'legacy',
                        key: {
                            scopeKey,
                            cwd: spawnCwd, model, effort, fastMode: effectiveFastMode,
                        },
                        storedThreadId: resumeSessionId || null,
                        instructions: sysPrompt,
                        forceNew,
                    });
                    return { kind: 'lease', lease };
                }

                mainRun!.cancelPending = cancelThisAcquire;
                const waitMs = configuredPositiveMs(
                    process.env["CODEX_APP_ACQUIRE_WAIT_MS"],
                    DEFAULT_CODEX_APP_ACQUIRE_WAIT_MS,
                );
                const deadlineAt = Date.now() + waitMs;
                let lastStaleError: CodexHostGenerationStaleError | null = null;
                let staleAttempts = 0;

                const deadlineError = (stage: 'prepare' | 'acquire'): Error => lastStaleError
                    ?? new Error(`Codex App ${stage} timed out after ${waitMs}ms`);
                const awaitWithinDeadline = async <T>(
                    stage: 'prepare' | 'acquire',
                    pending: Promise<T>,
                    onLateValue?: (value: T) => void,
                ): Promise<T> => {
                    let deadlineWon = false;
                    let timeout: NodeJS.Timeout | undefined;
                    void pending.then((value) => {
                        if (deadlineWon) onLateValue?.(value);
                    }, () => {});
                    const remainingMs = deadlineAt - Date.now();
                    if (remainingMs <= 0) {
                        deadlineWon = true;
                        throw deadlineError(stage);
                    }
                    const deadline = new Promise<never>((_resolveDeadline, rejectDeadline) => {
                        timeout = setTimeout(() => {
                            deadlineWon = true;
                            rejectDeadline(deadlineError(stage));
                        }, remainingMs);
                    });
                    try {
                        return await Promise.race([pending, deadline]);
                    } finally {
                        if (timeout) clearTimeout(timeout);
                    }
                };

                for (;;) {
                    if (acquireWasCancelled()) return { kind: 'cancelled', reason: cancelReason };
                    // Check the budget before spawning more work. awaitWithinDeadline()
                    // only measures what remains once the promise already exists, so a
                    // backoff that consumed the last of the budget would still get to
                    // start one more prepare.
                    if (deadlineAt - Date.now() <= 0) throw lastStaleError ?? deadlineError('prepare');
                    try {
                        const prepared = await awaitWithinDeadline('prepare', prepareCodexAppHost({
                            binary: detected.path || 'codex', cwd: spawnCwd,
                            fastMode: effectiveFastMode, env: spawnEnv, model, effort,
                        }));
                        if (acquireWasCancelled()) return { kind: 'cancelled', reason: cancelReason };
                        const lease = await awaitWithinDeadline('acquire', acquireCodexAppLane(prepared, {
                            scopeKey,
                            bucketKey: currentBucket!,
                            storedThreadId: resumeSessionId || null,
                            instructions: sysPrompt,
                            forceNew,
                            waitMs: deadlineAt - Date.now(),
                        }), (lateLease) => { lateLease.release(); });
                        if (acquireWasCancelled()) {
                            lease.release();
                            return { kind: 'cancelled', reason: cancelReason };
                        }
                        return { kind: 'lease', lease };
                    } catch (err: unknown) {
                        if (!(err instanceof CodexHostGenerationStaleError)) throw err;
                        lastStaleError = err;
                        if (acquireWasCancelled()) return { kind: 'cancelled', reason: cancelReason };
                        const remainingMs = deadlineAt - Date.now();
                        if (remainingMs <= 0) throw lastStaleError;
                        staleAttempts += 1;
                        const backoffMs = Math.min(
                            remainingMs,
                            CODEX_APP_ACQUIRE_RETRY_BACKOFF_MAX_MS,
                            25 * staleAttempts,
                        );
                        await new Promise<void>((done) => { setTimeout(done, backoffMs); });
                    }
                }
            } finally {
                const latest = activeMainProcesses.get(scopeKey);
                if (latest?.cancelPending === cancelThisAcquire) delete latest.cancelPending;
                mainRun!.starting = false;
            }
        };

        void acquireCodexAppForTurn().then(async (outcome) => {
            // A run that never started a turn owns nothing but its own map slot.
            // releaseMainRun() matches on (process, ownerGeneration), and a pending
            // run has process=null while sharing the global generation with whatever
            // replaced it, so calling it here would delete the replacement's entry.
            // Compare the captured object instead and only drop our own slot.
            const abandonTurn = (lease: { release(): void } | null): void => {
                lease?.release();
                finalizeTraceRun(traceRunId, 'interrupted');
                clearLiveRun(liveScope);
                broadcast('agent_status', { running: false, agentId: agentLabel });
                resolve!({ text: '', code: -1 });
                if (activeMainProcesses.get(scopeKey) === mainRun) activeMainProcesses.delete(scopeKey);
                void processQueue(scopeKey);
            };
            if (outcome.kind === 'cancelled') { abandonTurn(null); return; }
            const lease = outcome.lease;
            if (activeMainProcesses.get(scopeKey) !== mainRun) { abandonTurn(lease); return; }
            await runCodexAppTurn(lease.client, lease, lease.laneScope);
        }).catch((err: Error) => {
            console.error(`[codex-app:pool] acquire failed: ${err.message}`);
            clearLiveRun(liveScope);
            broadcast('agent_status', { running: false, agentId: agentLabel });
            broadcast('agent_done', { text: `❌ Codex AppServer acquire failed: ${err.message}`, error: true, origin }, 'public');
            releaseMainRun(scopeKey, null, ownerGeneration);
            resolve!({ text: '', code: 1 });
            void processQueue(scopeKey);
        });

        return { child: null, promise: resultPromise };
    }

    // ─── Standard CLI branch (claude/codex/opencode) ──────
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
    if (mainManaged) mainRun!.process = child;
    else registerActiveProcess(agentLabel, child);
    if (!opts.internal) broadcast('agent_status', { running: true, agentId: agentLabel, cli, ...runtimeStatusMeta, ...empTag });
    if (mainManaged && !opts.internal) beginLiveRun(liveScope, cli);

    // The turn settles on 'close', which waits for every stdio stream to close.
    // A descendant that inherited these pipes can outlive the child and hold
    // them open forever, so bound that wait while still draining short tails.
    const releaseExitDrain = releaseChildOutputAfterExit(child, {
        onRelease: (reason) => {
            console.warn(`[jaw:drain] ${agentLabel} exited but output stayed open — released after ${reason}`);
        },
    });

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
        releaseExitDrain();
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
        if (mainManaged) {
            releaseMainRun(scopeKey, child, ownerGeneration);
            clearLiveRun(liveScope);
            broadcast('agent_status', { running: false, agentId: agentLabel });
        } else {
            activeProcesses.delete(agentLabel);
        }
        broadcast('agent_done', { text: `❌ ${msg}`, error: true, origin, ...empTag }, isEmployee ? 'internal' : 'public');
        resolve!({ text: '', code: 127 });
        if (mainManaged) void processQueue(scopeKey);
    });

    if (mainManaged && !opts.internal && !opts._skipInsert) {
        insertMessage.run('user', prompt, cli, runtimeModel, settings["workingDir"] || null, chatSessionId);
    }

    if (cli === 'claude') {
        child.stdin.write(isResume ? prompt : withHistoryPrompt(prompt, historyBlock));
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
        runStartedAt: Date.now(),
        sessionId: ((kiroPlainText || cli === 'agy') && isResume && resumeSessionId) ? resumeSessionId : null,
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
        ...(opencodeSpawnAudit ? { opencodeSpawnAudit: opencodeSpawnAudit as Record<string, unknown> } : {}),
        ...(agyResumeOffset > 0 ? { agyResumeOffset, agyBytesReceived: 0 } : {}),
        ...(cli === 'agy' ? {
            agyTranscriptMode: 'not-started' as const,
            agyLastActivitySource: 'none' as const,
            ...(agyBootstrap ? {
                agyBootstrapSentinel: agyBootstrap.sentinel,
                agyBootstrapHash: agyBootstrap.hash,
                metadata: { agyPromptSpill: agyBootstrap.spill },
            } : {}),
            agyBootstrapAccepted: false,
            agyBootstrapAcceptanceMode: agyBootstrap ? 'pending' as const : 'not-applicable' as const,
        } : {}),
        ...(kiroPlainText || cli === 'agy' || cli === 'pi' ? { liveOutputText: '' } : {}),
        ...(kiroPlainText ? { kiroLastVisibleAt: Date.now(), kiroHeartbeatSent: false } : {}),
    };
    let agyClosing = false;
    let agyGuardedStaleDetected = false;
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
                    killProcessTreeIfAlive(child);
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
        if (cli === 'agy') {
            ctx.agyTranscriptMode = classifyAgyTranscriptMode(ctx);
            const agyWatchdogContext = formatAgyWatchdogContext(ctx);
            ctx.stderrBuf = ctx.stderrBuf ? `${ctx.stderrBuf}\n${agyWatchdogContext}` : agyWatchdogContext;
            pushTrace(ctx, agyWatchdogContext);
        }
        if (child.pid) {
            killProcessTree(child.pid, 'SIGTERM');
            setTimeout(() => {
                killProcessTreeIfAlive(child);
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
            onEmit: (emitCtx, tool, label, _cliName, tag, _audience) => {
                stampTraceTool(tool, emitCtx, tool.toolType || 'tool');
                if (emitCtx.liveScope) replaceLiveRunTools(emitCtx.liveScope, emitCtx.toolLog);
                appendParentLiveRunTool(emitCtx, tool);
                emitAgentTool(emitCtx, label, tool, tag);
                scheduleAgyQuietCompletion();
            },
            onActivity: () => {
                ctx.stallWatchdog?.markProgress();
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
        if (cli === 'grok' || (cli === 'ai-e' && ctx.effectiveProvider === 'grok')) {
            ctx.stallWatchdog?.markProgress();
        }
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
            ctx.agyLastActivitySource = 'stdout';
            const rawText = agyUtf8!.write(chunk);
            if (!rawText) return;
            ctx.stallWatchdog?.markProgress();
            // Defensive ANSI strip (belt-and-suspenders with NO_COLOR=1)
            const text = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
            appendAgyFullText(ctx, text);
            if (agyResumeDecision.ok && !agyGuardedStaleDetected && isAgyStaleSessionOutput(text)) {
                agyGuardedStaleDetected = true;
                console.log('[jaw:agy] stale guarded resume output detected — terminating for fresh retry');
                if (child.pid) killProcessTree(child.pid, 'SIGTERM');
                return;
            }
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
            if (shouldFreezeAgyLiveDisplay(ctx)) {
                // Display frozen past AGY_LIVE_DISPLAY_MAX_CHARS; the close path
                // promotes the full text into the live candidate (finalizeAgyFallbackText).
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
            ctx.stallWatchdog?.markProgress();
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
        const clampedPending = clampPendingLine(buffer);
        if (clampedPending.overflowed) {
            console.warn(`[jaw:${agentLabel}] stdout line exceeded the pending-line cap without a newline — truncating`);
            buffer = clampedPending.buffer;
        }
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
        if (cli === 'agy') ctx.agyLastActivitySource = 'stderr';
        if ((kiroPlainText || cli === 'agy') && text) ctx.stallWatchdog?.markProgress();
        appendTraceEvent({ runId: ctx.traceRunId, source: 'stderr', eventType: 'stderr', raw: text });
        console.error(`[jaw:stderr:${agentLabel}] ${text}`);
        if (ctx.stderrBuf.length < 4000) ctx.stderrBuf += text + '\n';
        scheduleAgyQuietCompletion();
    });

    child.on('close', (code) => {
        clearOpencodeIdleTimer();
        clearAgyQuietCompletionTimer();
        stallWatchdog.stop();
        releaseExitDrain();
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
            if (remaining) appendAgyFullText(ctx, remaining);
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
        if (cli === 'agy') {
            ctx.agyTranscriptMode = classifyAgyTranscriptMode(ctx);
        }
        if (cli === 'agy' && isResume && (agyGuardedStaleDetected || isAgyStaleSessionOutput(ctx.fullText))) {
            console.log(`[jaw:agy] stale session detected (Warning: conversation not found) — clearing bucket`);
            try {
                const bucket = currentBucket;
                clearSessionBucket.run(bucket);
            } catch (e) { console.warn('[jaw:agy] stale bucket clear failed:', (e as Error).message); }
            ctx.sessionId = null;
            if (agyResumeDecision.ok && !opts._agyStaleFreshRetry) {
                if (mainManaged) releaseMainRun(scopeKey, child, ownerGeneration);
                else activeProcesses.delete(agentLabel);
                const { promise: freshPromise } = spawnAgent(prompt, {
                    ...opts, _agyStaleFreshRetry: true, _skipResume: true, _skipInsert: true,
                });
                freshPromise.then(resolve!).catch((error: Error) => resolve!({ text: error.message, code: 1 }));
                return;
            }
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
                    const bucket = currentBucket;
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
                if (isAgyIntermediatePlannerText(ctx.agyFinalPlannerText)) {
                    ctx.fullText = AGY_PLANNER_ONLY_NOTICE;
                    if (ctx.liveOutputText !== undefined) ctx.liveOutputText = AGY_PLANNER_ONLY_NOTICE;
                    ctx.agyFinalPlannerSeen = false;
                    ctx.agyFinalPlannerText = undefined;
                    ctx.metadata = { ...ctx.metadata, agyPlannerOnly: true };
                } else {
                    ctx.fullText = ctx.agyFinalPlannerText;
                    if (ctx.liveOutputText !== undefined) ctx.liveOutputText = ctx.agyFinalPlannerText;
                }
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
        const agyTranscriptErrorMessage = cli === 'agy' && !agyTimedOut
            ? resolveAgyEmptyCloseError(ctx)
            : null;
        if (cli === 'agy' && !agyTimedOut && !agyTranscriptErrorMessage) {
            // Mirror the per-chunk display derivation ORDER (replay → echo → tracker →
            // normalize). The close-path strips above run echo-before-replay and can
            // leave a prompt echo in resumed output; every strip is a prefix-stripper
            // that no-ops when the prefix is already gone, so re-running them in
            // per-chunk order is idempotent and safe.
            const promotedBase = isResume
                ? stripAgyResumeReplayPrefixes(ctx.fullText, agyResumeReplayPrefixes).text
                : ctx.fullText;
            const promotedEcho = stripAgyPromptEchoPrefix(promotedBase, promptForArgs).text;
            finalizeAgyFallbackText(ctx, normalizeAssistantDisplayText(stripInterviewTracker(promotedEcho)));
        }
        if (cli === 'agy') pushTrace(ctx, describeAgyFinalSource(ctx));
        if (cli === 'agy') {
            ctx.metadata = {
                ...ctx.metadata,
                agyCheckpointSeen: ctx.metadata?.['agyCheckpointSeen'] === true,
                agyPlannerOnly: ctx.metadata?.['agyPlannerOnly'] === true
                    && ctx.toolLog.length === 0
                    && !ctx.agyFinalPlannerSeen,
            };
        }
        const effectiveExitCode = agyCompletedByQuietOutput && !agyTranscriptErrorMessage
            ? 0
            : agyTranscriptErrorMessage
                ? 1
                : agyTimedOut ? 124 : ctx.stallReason ? 124 : code;
        if (agyTimedOut) {
            const message = formatAgyTimeoutMessage(agyTimeoutMessage);
            ctx.stderrBuf = ctx.stderrBuf ? `${ctx.stderrBuf}\n${message}` : message;
            ctx.fullText = '';
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'runtime_error', raw: message });
        } else if (agyTranscriptErrorMessage) {
            ctx.stderrBuf = ctx.stderrBuf ? `${ctx.stderrBuf}\n${agyTranscriptErrorMessage}` : agyTranscriptErrorMessage;
            ctx.fullText = '';
            if (ctx.liveOutputText !== undefined) ctx.liveOutputText = '';
            appendTraceEvent({ runId: ctx.traceRunId, source: 'cli_raw', eventType: 'runtime_error', raw: agyTranscriptErrorMessage });
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
            prompt, opts, cfg, ownerGeneration, persistenceOwner, forceNew, empSid,
            isResume, wasKilled, wasSteer, smokeResult,
            effortDefault: cli === 'grok' ? '' : 'medium', costLine,
            resolve: resolve!,
            activeProcesses,
            scopeKey,
            scopedBucket: currentBucket,
            chatSessionId,
            childProcess: child,
            releaseMainRun,
            retryState: queueCtrl.retryStateForScope(scopeKey),
            fallbackState: queueCtrl.fallbackStateForScope(scopeKey),
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
