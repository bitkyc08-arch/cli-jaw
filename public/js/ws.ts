// ── Server Event Connection (SSE via event-channel) ──
import { state } from './state.js';
import { API_BASE } from './api.js';
import { connectEventChannel, subscribe, onChannelOpen, onChannelDisconnect, onChannelUnavailable } from './event-channel.js';
import { setStatus, updateQueueBadge, addSystemMsg, appendAgentText, finalizeAgent, addMessage, showProcessStep, cleanupToolActivity, applyQueuedOverlay, hydrateActiveRun, reconcileChatBottomAfterRestore, showChatRestoreIndicator, markSteered, clearSteer, isRecentSteer } from './ui.js';
import { renderPendingQueue } from './features/pending-queue.js';
import { t, getLang } from './features/i18n.js';
import { getVirtualScroll } from './virtual-scroll.js';
import { ICONS } from './icons.js';
import { escapeHtml, cancelPostRender } from './render.js';
import type { HeartbeatRuntimeState, OrcStateName, ResolvedSelectionState } from './state.js';
import { notifyUnreadResponse } from './features/attention-badge.js';
import { shouldApplyOrcStateEvent } from './features/orchestrate-scope.js';
import { providerLabel } from './provider-icons.js';
import { handleSessionListBroadcast } from './features/session-hub.js';

const ROADMAP_PHASES = ['I', 'P', 'A', 'B', 'C'] as const;

/** Track current phase for resize recalculation */
let currentSharkPhase: string | null = null;

/** Position shark midway between active dot and next dot.
 *  For C (last phase), center on the C dot itself.
 *  Uses dot midpoints to avoid CENTER brand element skewing connector index mapping. */
function positionShark(roadmap: HTMLElement, shark: HTMLElement, phase: string): void {
    const idx = ROADMAP_PHASES.indexOf(phase as typeof ROADMAP_PHASES[number]);
    if (idx < 0) return;
    const barRect = roadmap.getBoundingClientRect();
    const sharkW = shark.offsetWidth || 36;
    const dot = document.getElementById(`dot-${phase}`);
    if (!dot) return;

    const nextPhase = ROADMAP_PHASES[idx + 1];
    const nextDot = nextPhase ? document.getElementById(`dot-${nextPhase}`) : null;
    if (nextDot) {
        const dotRect = dot.getBoundingClientRect();
        const nextRect = nextDot.getBoundingClientRect();
        const mid = (dotRect.right + nextRect.left) / 2;
        shark.style.transform = `translateX(${mid - barRect.left - sharkW / 2}px)`;
    } else {
        const dotRect = dot.getBoundingClientRect();
        shark.style.transform = `translateX(${dotRect.left - barRect.left + dotRect.width / 2 - sharkW / 2}px)`;
    }
}

interface WsMessage {
    type: string;
    scope?: string;
    running?: boolean;
    status?: string;
    agentId?: string;
    phase?: string;
    phaseLabel?: string;
    pending?: number;
    queued?: Array<{ id: string; prompt: string; source?: string; ts?: number }>;
    path?: string;
    round?: number;
    agentPhases?: { agent?: string; name?: string }[];
    subtasks?: { agent?: string; name?: string }[];
    action?: string;
    icon?: string;
    rawIcon?: string;
    label?: string;
    toolType?: string;
    detail?: string;
    stepRef?: string;
    traceRunId?: string;
    traceSeq?: number;
    detailAvailable?: boolean;
    detailBytes?: number;
    rawRetentionStatus?: string;
    /** Server run-start (ms) riding on agent_tool — authoritative elapsed origin. */
    startedAt?: number;
    text?: string;
    toolLog?: { icon: string; label: string; detail?: string; toolType?: string; stepRef?: string; isEmployee?: boolean; traceRunId?: string; traceSeq?: number; detailAvailable?: boolean; detailBytes?: number; rawRetentionStatus?: string }[];
    from?: string;
    to?: string;
    source?: string;
    role?: string;
    content?: string;
    cli?: string;
    delay?: number;
    state?: string;
    title?: string;
    isEmployee?: boolean;
    fromQueue?: boolean;
    external?: boolean;
    reason?: HeartbeatRuntimeState['reason'];
    policy?: HeartbeatRuntimeState['policy'];
    jobId?: string;
    jobName?: string;
    deferredPending?: number;
    taskAnchor?: string | null;
    resolvedSelection?: ResolvedSelectionState | null;
    buildBudget?: {
        maxWorkerDispatches: number;
        maxSelfHealRetries: number;
        maxVerificationRounds: number;
        spent: {
            workerDispatches: number;
            selfHealRetries: number;
            verificationRounds: number;
        };
    } | null;
    interview?: { known: string[]; unknown: string[]; round: number } | null;
    delaySeconds?: number;
    attempts?: number;
    code?: string;
    employeeName?: string;
    exitCode?: number;
    error?: string;
    message?: string;
    steered?: boolean;
    steerWaitMs?: number;
    textLen?: number;
    sseReplay?: boolean;
    deleted?: { id?: string; seq?: number };
}

// Agent phase state (populated by agent_status events from orchestrator)
const agentPhaseState: Record<string, { phase: string; phaseLabel: string }> = {};

// ── Run-scoped SSE replay idempotency ─────────────────────────────────
// SSE reconnects replay ring-buffer events the page may have already
// processed (event-channel `?lastEventId=` → routes/events replaySince).
// The dispatcher used to apply replays as live: a replayed agent_done from
// a FINISHED turn would mid-turn-finalize the in-flight live block (freezing
// a partial copy as a VS item) and replayed agent_output chunks re-appended
// text the block already showed. Guards below scope the agent stream to the
// trace run that owns it (devlog 260612 manager_stream_hidden_state_audit
// 06_rca + 08_patch).
const FINALIZED_RUN_MEMORY = 8;
// 64: with public employee tool mirrors (260613 20 P2-i) every employee run
// contributes a traceRunId — 16 could evict the BOSS run's cursor mid-run and
// silently disable the replay guard (260613 04 §3).
const TOOL_SEQ_RUN_MEMORY = 64;
let liveTraceRunId: string | null = null;
let liveAppliedTextLen = 0;
const finalizedTraceRuns: string[] = [];
const liveAppliedToolSeqByRun = new Map<string, number>();

function isFinalizedRun(runId: string | null): boolean {
    return runId !== null && finalizedTraceRuns.includes(runId);
}

function positiveSeq(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function rememberAppliedToolSeq(runId: string | null, seq: number | null): void {
    if (!runId || seq == null) return;
    const prev = liveAppliedToolSeqByRun.get(runId) || 0;
    if (seq > prev) liveAppliedToolSeqByRun.set(runId, seq);
    while (liveAppliedToolSeqByRun.size > TOOL_SEQ_RUN_MEMORY) {
        // Pin the live boss run: evicting its cursor mid-run would disable
        // the replay guard exactly when it matters (260613 04 §3).
        let oldest: string | null = null;
        for (const key of liveAppliedToolSeqByRun.keys()) {
            if (key !== liveTraceRunId) { oldest = key; break; }
        }
        if (!oldest) break;
        liveAppliedToolSeqByRun.delete(oldest);
    }
}

/** Max applied traceSeq per run id in the hydrated toolLog. The parent's
 *  toolLog interleaves boss tools AND employee-mirror tools (each employee
 *  run has its own traceRunId) — seeding only the boss run left replayed
 *  employee tools unguarded after reconnect (adversarial review #7). */
function appliedToolSeqByRun(activeRun?: { toolLog?: Array<{ traceRunId?: string; traceSeq?: number }> } | null): Map<string, number> {
    const maxByRun = new Map<string, number>();
    for (const tool of activeRun?.toolLog || []) {
        const runId = typeof tool?.traceRunId === 'string' && tool.traceRunId ? tool.traceRunId : null;
        const seq = positiveSeq(tool?.traceSeq);
        if (!runId || seq == null) continue;
        if (seq > (maxByRun.get(runId) || 0)) maxByRun.set(runId, seq);
    }
    return maxByRun;
}

function shouldDropReplayedTool(runId: string | null, seq: number | null, replay?: boolean): boolean {
    if (!replay || !runId || seq == null) return false;
    const applied = liveAppliedToolSeqByRun.get(runId) || 0;
    return seq <= applied;
}

/** Record the turn that just finalized and reset the live cursors. Pass the
 *  event's runId when present; falls back to the adopted live run id. */
function markRunFinalized(runId: string | null): void {
    const finalized = runId ?? liveTraceRunId;
    liveTraceRunId = null;
    liveAppliedTextLen = 0;
    if (finalized && !finalizedTraceRuns.includes(finalized)) {
        finalizedTraceRuns.push(finalized);
        if (finalizedTraceRuns.length > FINALIZED_RUN_MEMORY) finalizedTraceRuns.shift();
    }
}

/** Adopt the run id carried by a live agent_* event. A different id means a
 *  new turn started — the text cursor restarts from zero. */
function adoptLiveRun(runId: string | null): void {
    if (!runId || runId === liveTraceRunId) return;
    liveTraceRunId = runId;
    liveAppliedTextLen = 0;
}

/** Align the cursors with the authoritative orchestrate snapshot after a
 *  reconnect/restore hydration: the hydrated block already renders the full
 *  cumulative `snapshot.text`, so replayed chunks at or below that length
 *  must be dropped, not re-appended. */
function syncLiveRunCursor(activeRun?: { running?: boolean; traceRunId?: string; text?: string; textLen?: number; toolLog?: Array<{ traceRunId?: string; traceSeq?: number }> } | null): void {
    if (!activeRun?.running) return;
    if (typeof activeRun.traceRunId === 'string' && activeRun.traceRunId) {
        liveTraceRunId = activeRun.traceRunId;
    }
    // Prefer the server's uncapped cumulative counter: `text` is tail-capped
    // (live-run-state MAX_LIVE_TEXT_CHARS), so its length under-reports the
    // cursor once a run streams past the cap (260613 05 finding 9).
    liveAppliedTextLen = typeof activeRun.textLen === 'number'
        ? activeRun.textLen
        : (activeRun.text || '').length;
    for (const [runId, seq] of appliedToolSeqByRun(activeRun)) {
        rememberAppliedToolSeq(runId, seq);
    }
}

let currentOrcScope = '';
let lastLoadTs = 0;
let snapshotSyncInFlight: Promise<void> | null = null;
let lastSnapshotSyncAt = 0;
let restoreHooksRegistered = false;
let lastRestoreTriggerAt = 0;
const SNAPSHOT_SYNC_THROTTLE_MS = 750;
const RESTORE_TRIGGER_DEBOUNCE_MS = 750;

async function refreshRuntimeSnapshot(options: { hydrateRun?: boolean } = {}): Promise<void> {
    const response = await fetch(`${API_BASE}/api/orchestrate/snapshot`);
    const snap = await response.json();
    currentOrcScope = String(snap.orc.scope || '');
    applyOrcState(snap.orc.state);
    applyOrcContext(snap.orc.ctx || null);
    applyHeartbeatRuntime(snap.heartbeat || { pending: 0, deferredPending: 0 });
    hydrateAgentPhases(snap.workers);
    updateQueueBadge(snap.runtime.queuePending);
    applyQueuedOverlay(snap.queued || []);
    renderPendingQueue(snap.queued || []);
    if (options.hydrateRun) {
        hydrateActiveRun(snap.activeRun);
        // The hydrated block now renders the snapshot's cumulative state —
        // move the replay cursors there so replayed chunks older than the
        // snapshot are dropped instead of re-appended.
        syncLiveRunCursor(snap.activeRun);
    }
    hydrateGoalState();
    if (snap.runtime.busy) {
        setStatus('running');
    } else if (!isRecentSteer()) {
        setStatus('idle');
    }
    import('./features/employees.js').then(m => {
        if (typeof m.renderEmployees === 'function') m.renderEmployees();
    });
}

export function syncOrchestrateSnapshot(reason = 'manual', options: { hydrateRun?: boolean } = {}): Promise<void> {
    const now = Date.now();
    if (!options.hydrateRun) {
        if (snapshotSyncInFlight) return snapshotSyncInFlight;
        if (now - lastSnapshotSyncAt < SNAPSHOT_SYNC_THROTTLE_MS) return Promise.resolve();
        lastSnapshotSyncAt = now;
        snapshotSyncInFlight = refreshRuntimeSnapshot(options)
            .catch(error => {
                console.warn(`[ws] orchestrate snapshot sync failed (${reason})`, error);
                throw error;
            })
            .finally(() => {
                snapshotSyncInFlight = null;
            });
        return snapshotSyncInFlight;
    }
    return refreshRuntimeSnapshot(options);
}

// devlog 260609 75/82: these restore reasons can represent a hidden/navigated
// document that missed history-changing events — durable history must reload
// before snapshot hydration. focus/resume stay snapshot-only (reload churn).
function shouldReloadMessagesForRestore(reason: string): boolean {
    return reason === 'iframe-visible'
        || reason === 'pageshow'
        || reason === 'discard'
        || reason === 'visibilitychange';
}

function syncAfterBrowserRestore(reason: string): void {
    showChatRestoreIndicator(reason);
    void import('./ui.js').then(async m => {
        // 83: lastLoadTs > 0 — the boot channel-up load owns first paint; the
        // onLoad visibility ping must not race it during an iframe remount.
        if (shouldReloadMessagesForRestore(reason) && lastLoadTs > 0) {
            try {
                await m.loadMessages();
                lastLoadTs = Date.now();
            } catch (error) {
                console.warn(`[ws] restore loadMessages failed (${reason})`, error);
            }
        }
        await syncOrchestrateSnapshot(reason, { hydrateRun: true });
    })
        .catch(() => { /* snapshot not critical — UI recovers on next event */ })
        .finally(() => {
            reconcileChatBottomAfterRestore(reason);
        });
}

function requestBrowserRestoreSync(reason: string): void {
    const now = Date.now();
    // History-reloading restores (iframe-visible/pageshow/discard/…) must not
    // be swallowed by a snapshot-only restore that fired just before them —
    // e.g. 'focus' lands ~100ms ahead of the manager's iframe-visible ping
    // and would otherwise consume the debounce slot, leaving stale history.
    // Only snapshot-only restores debounce; heavy reloads coalesce via the
    // loadMessages single-flight instead.
    if (!shouldReloadMessagesForRestore(reason)
        && now - lastRestoreTriggerAt < RESTORE_TRIGGER_DEBOUNCE_MS) return;
    lastRestoreTriggerAt = now;
    syncAfterBrowserRestore(reason);
}

// devlog 260609 78/82: the settings_change payload always carries projectDirs,
// so scope sensitivity must be read from changedKeys. workingDir keys the
// message-history scope (origin+pathname::workingDir); projectDirs rides the
// same path for forward-compat and resolves to a signature-skip no-op today.
function handleSettingsChange(msg: { cli?: string; projectDirs?: string[] | null; changedKeys?: string[] }): void {
    const changedKeys = Array.isArray(msg.changedKeys) ? msg.changedKeys : [];
    // Turning multi-session on or off changes what the SERVER puts on every event and
    // what this tab is subscribed to, and the two are decided at different times: the
    // session view is built once at boot and the channel carries the scope it produced.
    // Leaving a live page running across that change gives one of two bad outcomes — a
    // tab still filtered to `local:<id>` after the server stopped stamping scopes goes
    // silent, and an unscoped connection after the gate comes on starts receiving every
    // session's output. Neither is repairable from here, so the page reloads (072 §1.3a).
    if (changedKeys.includes('multiSession')) {
        window.location.reload();
        return;
    }
    if (changedKeys.includes('workingDir') || changedKeys.includes('projectDirs')) {
        // 82 A-phase audit: never reassign snapshotReady here — only
        // channel-up/replay-gap own that promise (orc_state gate awaits it).
        void import('./ui.js').then(async m => {
            try {
                await m.loadMessages();
                lastLoadTs = Date.now();
            } catch (error) {
                console.warn('[ws] settings scope loadMessages failed', error);
            }
            await syncOrchestrateSnapshot('settings_change')
                .catch(() => { /* snapshot not critical — UI recovers on next event */ })
                .finally(() => m.reconcileChatBottomAfterRestore('settings_change'));
        });
    } else {
        syncOrchestrateSnapshot('settings_change').catch(() => {});
    }
    import('./features/settings-core.js')
        .then(m => m.refreshHeaderFromSettingsChange(msg))
        .catch(() => { /* header refresh is cosmetic — next loadSettings corrects it */ });
}

function registerOrchestrateRestoreHooks(): void {
    if (restoreHooksRegistered) return;
    restoreHooksRegistered = true;
    window.addEventListener('focus', () => {
        requestBrowserRestoreSync('focus');
    });
    window.addEventListener('pageshow', (event: PageTransitionEvent) => {
        if (!event.persisted) return;
        requestBrowserRestoreSync('pageshow');
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            requestBrowserRestoreSync('visibilitychange');
        }
    });
    document.addEventListener('resume', () => {
        requestBrowserRestoreSync('resume');
    });
    if ('wasDiscarded' in document
        && Boolean((document as Document & { wasDiscarded?: boolean }).wasDiscarded)) {
        requestBrowserRestoreSync('discard');
    }
    window.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'jaw-preview-visibility' && event.data.visible) {
            requestBrowserRestoreSync('iframe-visible');
        }
    });
}

/** Hydrate agent phase cache from snapshot (used after reconnect) */
export function hydrateAgentPhases(workers: Array<{
    agentId: string;
    state: string;
    phase?: string;
    phaseLabel?: string;
}>) {
    for (const key of Object.keys(agentPhaseState)) {
        delete agentPhaseState[key];
    }
    for (const w of workers) {
        if (w.state === 'running' && w.phase) {
            agentPhaseState[w.agentId] = {
                phase: w.phase,
                phaseLabel: w.phaseLabel || '',
            };
        }
    }
}

function applyHeartbeatRuntime(input: Partial<HeartbeatRuntimeState> | null | undefined): void {
    const runtime: HeartbeatRuntimeState = {
        pending: Number(input?.pending || 0),
        deferredPending: Number(input?.deferredPending || 0),
        ...(input?.reason ? { reason: input.reason } : {}),
        ...(input?.policy ? { policy: input.policy } : {}),
        ...(input?.jobId ? { jobId: input.jobId } : {}),
        ...(input?.jobName ? { jobName: input.jobName } : {}),
    };
    state.heartbeatRuntime = runtime;

    const el = document.getElementById('pabcHeartbeatStatus');
    if (!el) return;
    if (runtime.reason === 'pabcd_active' && runtime.deferredPending > 0) {
        const suffix = runtime.jobName ? `: ${runtime.jobName}` : '';
        el.textContent = `heartbeat deferred (${runtime.deferredPending})${suffix}`;
        el.hidden = false;
    } else {
        el.textContent = '';
        el.hidden = true;
    }
}

function applyOrcContext(ctx: { taskAnchor?: string | null; resolvedSelection?: ResolvedSelectionState | null; interview?: { known: string[]; unknown: string[]; round: number } | null } | null): void {
    state.orcTaskAnchor = String(ctx?.taskAnchor || '').trim();
    state.orcResolvedSelection = ctx?.resolvedSelection || null;

    const el = document.getElementById('pabcTaskAnchor');
    if (!el) return;
    if (state.orcTaskAnchor) {
        const selected = state.orcResolvedSelection?.index ? `${state.orcResolvedSelection.index}. ` : '';
        el.textContent = `anchor: ${selected}${state.orcTaskAnchor}`;
        el.hidden = false;
    } else {
        el.textContent = '';
        el.hidden = true;
    }
    renderInterviewPanel(ctx?.interview || null);
}

let interviewCollapsed: boolean = (() => {
    try { return localStorage.getItem('jaw:interviewCollapsed') === '1'; } catch { return false; }
})();

function setInterviewCollapsed(collapsed: boolean): void {
    interviewCollapsed = collapsed;
    try { localStorage.setItem('jaw:interviewCollapsed', collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
    const panel = document.getElementById('interviewPanel');
    if (!panel) return;
    panel.classList.toggle('collapsed', collapsed);
    const toggle = panel.querySelector('.iv-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
}

interface InterviewEvidenceView {
    fact: string;
    source?: string;
    confidence?: number;
    turnNumber?: number;
    dimension?: string;
}

interface DimensionAssessmentView {
    goal: string;
    constraint: string;
    success: string;
    ontology: string;
}

function renderDimensionBars(assessment: DimensionAssessmentView): string {
    const levelToScore = (l: string) => {
        switch (l) {
            case 'max': return 1.0;
            case 'xhigh': return 0.8;
            case 'high': return 0.6;
            case 'medium': return 0.4;
            default: return 0.2;
        }
    };
    const levelColor = (l: string) => {
        switch (l) {
            case 'max': return '#2196f3';
            case 'xhigh': return '#4caf50';
            case 'high': return '#8bc34a';
            case 'medium': return '#ff9800';
            default: return '#f44336';
        }
    };
    const scores = [levelToScore(assessment.goal), levelToScore(assessment.constraint), levelToScore(assessment.success), levelToScore(assessment.ontology)];
    const overall = 1 - (scores.reduce((a, b) => a + b, 0) / scores.length);
    const allMax = Object.values(assessment).every(v => v === 'max');
    const overallLabel = allMax ? '🟢 Ready' : overall <= 0.2 ? '🟢 Ready' : overall <= 0.4 ? '🟡 Almost' : '🔴 Needs work';

    const bar = (dim: string, level: string) => {
        const score = levelToScore(level);
        const pct = score * 100;
        const color = levelColor(level);
        return `<div style="display:flex;align-items:center;gap:6px;font-size:12px">
            <span style="width:70px;color:var(--text-secondary)">${dim}</span>
            <div style="flex:1;height:5px;background:var(--bg-tertiary);border-radius:3px">
                <div style="width:${pct}%;height:100%;background:${color};border-radius:3px;transition:width .3s"></div>
            </div>
            <span style="width:60px;text-align:right;font-weight:600;font-size:11px">${score.toFixed(1)} ${level.toUpperCase()}</span>
        </div>`;
    };
    return `<div style="display:flex;flex-direction:column;gap:3px;margin:6px 0">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">
            <span style="color:var(--text-secondary)">Ambiguity: ${overall.toFixed(2)}</span>
            <span>${overallLabel}</span>
        </div>
        ${bar('Goal', assessment.goal)}
        ${bar('Constraint', assessment.constraint)}
        ${bar('Success', assessment.success)}
        ${bar('Ontology', assessment.ontology)}
    </div>`;
}

function renderInterviewPanel(interview: { known: (string | InterviewEvidenceView)[]; unknown: string[]; round: number; assessment?: DimensionAssessmentView } | null): void {
    const panel = document.getElementById('interviewPanel');
    if (!panel) return;
    if (!interview || (!interview.known.length && !interview.unknown.length)) {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;
    panel.classList.toggle('collapsed', interviewCollapsed);

    const sourceIcon = (src?: string) => {
        switch (src) {
            case 'user_statement': return '🟢';
            case 'repo_fact': return '🔵';
            case 'inference': return '🟡';
            case 'assumption': return '🟠';
            case 'default': return '⚪';
            default: return '·';
        }
    };

    const knownHtml = interview.known.map(k => {
        if (typeof k === 'string') return `<li class="iv-known">· ${escapeHtml(k)}</li>`;
        const ev = k as InterviewEvidenceView;
        const icon = sourceIcon(ev.source);
        const dim = ev.dimension ? ` <span class="iv-dim">[${ev.dimension}]</span>` : '';
        return `<li class="iv-known">${icon} ${escapeHtml(ev.fact)}${dim}</li>`;
    }).join('');
    const unknownHtml = interview.unknown.map(u => `<li class="iv-unknown">❓ ${escapeHtml(typeof u === 'string' ? u : JSON.stringify(u))}</li>`).join('');
    panel.innerHTML = `
        <button type="button" class="iv-toggle" aria-expanded="${!interviewCollapsed}" aria-controls="interviewBody" title="인터뷰 트래커 접기/펼치기">
            <span class="iv-chevron" aria-hidden="true">▸</span>
            <span class="iv-summary">Interview · <span class="iv-known-count">Known ${interview.known.length}</span> · <span class="iv-unknown-count">Unknown ${interview.unknown.length}</span>${interview.known.filter(k => typeof k === 'object' && k && 'source' in k && (k as InterviewEvidenceView).source === 'assumption').length > 0 ? ` · <span class="iv-assumption-count">⚠️ ${interview.known.filter(k => typeof k === 'object' && k && 'source' in k && (k as InterviewEvidenceView).source === 'assumption').length} assumptions</span>` : ''} · Round ${interview.round}</span>
        </button>
        <div class="iv-body" id="interviewBody">
            ${interview.assessment ? `<div class="iv-section iv-section-ambiguity">${renderDimensionBars(interview.assessment)}</div>` : ''}
            <div class="iv-section iv-section-known"><strong>Known (${interview.known.length})</strong><ul>${knownHtml}</ul></div>
            <div class="iv-section iv-section-unknown"><strong>Unknown (${interview.unknown.length})</strong><ul>${unknownHtml}</ul></div>
        </div>
    `;
    if (!panel.dataset['toggleBound']) {
        panel.dataset['toggleBound'] = '1';
        panel.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.iv-toggle')) {
                setInterviewCollapsed(!interviewCollapsed);
            }
        });
    }
}

function renderBudgetPanel(budget: { maxWorkerDispatches: number; maxSelfHealRetries: number; maxVerificationRounds: number; spent: { workerDispatches: number; selfHealRetries: number; verificationRounds: number } } | null, orcState: string): void {
    const panel = document.getElementById('budgetPanel');
    if (!panel) return;
    if (!budget || orcState !== 'B') { panel.hidden = true; return; }
    panel.hidden = false;
    const bar = (label: string, spent: number, max: number) => {
        const pct = max > 0 ? Math.min((spent / max) * 100, 100) : 0;
        const color = pct >= 100 ? '#f44336' : pct >= 66 ? '#ff9800' : '#4caf50';
        return `<div style="display:flex;align-items:center;gap:6px;font-size:12px">
            <span style="width:70px;color:var(--text-secondary)">${label}</span>
            <div style="flex:1;height:5px;background:var(--bg-tertiary);border-radius:3px">
                <div style="width:${pct}%;height:100%;background:${color};border-radius:3px"></div>
            </div>
            <span style="width:30px;text-align:right;font-size:11px">${spent}/${max}</span>
        </div>`;
    };
    panel.innerHTML = `<div style="font-size:11px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Build Budget</div>
        ${bar('Workers', budget.spent.workerDispatches, budget.maxWorkerDispatches)}
        ${bar('Self-heal', budget.spent.selfHealRetries, budget.maxSelfHealRetries)}
        ${bar('Verify', budget.spent.verificationRounds, budget.maxVerificationRounds)}`;
}

async function hydrateGoalState(): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/api/goal`);
        if (!res.ok) return;
        const data = await res.json() as { goal?: { id: string; objective: string; status: string; createdAt: string; updatedAt: string; lastCheckpoint?: { summary: string; nextAction: string } } | null };
        if (data.goal) {
            state.activeGoal = {
                id: data.goal.id,
                objective: data.goal.objective,
                status: data.goal.status as 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled',
                createdAt: data.goal.createdAt,
                updatedAt: data.goal.updatedAt,
                lastCheckpointSummary: data.goal.lastCheckpoint?.summary,
                nextAction: data.goal.lastCheckpoint?.nextAction,
            };
        } else {
            state.activeGoal = null;
        }
        renderGoalCockpit();
    } catch { /* noop */ }
}

function renderGoalCockpit(): void {
    const el = document.getElementById('goalCockpit');
    if (!el) return;
    const goal = state.activeGoal;
    if (!goal || goal.status === 'complete' || goal.status === 'cancelled') {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }
    el.hidden = false;
    el.replaceChildren();
    const statusClass = goal.status === 'paused' ? 'paused' : goal.status === 'blocked' ? 'blocked' : 'active';
    const objSpan = document.createElement('span');
    objSpan.className = 'goal-objective';
    objSpan.title = goal.objective;
    objSpan.textContent = goal.objective;
    const statusSpan = document.createElement('span');
    statusSpan.className = `goal-status goal-status--${statusClass}`;
    statusSpan.textContent = goal.status;
    el.append(objSpan, statusSpan);
    if (goal.nextAction) {
        const nextSpan = document.createElement('span');
        nextSpan.className = 'goal-next';
        nextSpan.textContent = goal.nextAction;
        el.append(nextSpan);
    }
}

/** Apply orchestration state to UI (shared by WS events and reconnect snapshot) */
function applyOrcState(orcState: string, title?: string) {
    const allowed = new Set<OrcStateName>(['IDLE', 'I', 'P', 'A', 'B', 'C', 'D']);
    const nextState = allowed.has(orcState as OrcStateName) ? (orcState as OrcStateName) : 'IDLE';
    state.orcState = nextState;

    if (nextState === 'IDLE' || nextState === 'D') {
        document.body.removeAttribute('data-orc-state');
        document.body.style.removeProperty('--orc-glow');
    } else {
        document.body.setAttribute('data-orc-state', nextState);
        const glowVar = `--orc-glow-${nextState}`;
        const glow = getComputedStyle(document.documentElement).getPropertyValue(glowVar).trim();
        document.body.style.setProperty('--orc-glow', glow);
    }

    document.body.classList.add('orc-pulse');
    setTimeout(() => document.body.classList.remove('orc-pulse'), 700);

    const badge = document.getElementById('orcStateBadge');
    if (badge) {
        const labels: Record<OrcStateName, string> = {
            IDLE: '', I: 'INTERVIEW', P: 'PLAN', A: 'AUDIT', B: 'BUILD', C: 'CHECK', D: 'DONE',
        };
        badge.textContent = labels[nextState];
        badge.style.display = nextState === 'IDLE' ? 'none' : 'inline-block';
    }

    // ─── Roadmap Bar ───
    const roadmap = document.getElementById('pabcRoadmap');
    const shark = document.getElementById('sharkRunner');
    const brand = document.getElementById('pabcBrand');

    if (roadmap && shark) {
        if (!roadmap.dataset['resizeObserved']) {
            roadmap.dataset['resizeObserved'] = '1';
            new ResizeObserver(() => {
                if (currentSharkPhase && shark.classList.contains('running')) {
                    positionShark(roadmap, shark, currentSharkPhase);
                }
            }).observe(roadmap);
            let rafId = 0;
            window.addEventListener('resize', () => {
                cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                    if (currentSharkPhase && shark.classList.contains('running')) {
                        positionShark(roadmap, shark, currentSharkPhase);
                    }
                });
            });
        }

        if (nextState === 'IDLE') {
            roadmap.classList.remove('visible', 'shimmer-out');
            shark.classList.remove('running');
            currentSharkPhase = null;
        } else if (nextState === 'D') {
            ROADMAP_PHASES.forEach(p => {
                const dot = document.getElementById(`dot-${p}`);
                if (dot) { dot.className = 'pabc-dot done'; dot.setAttribute('data-phase', p); }
            });
            for (let i = 0; i < ROADMAP_PHASES.length; i++) {
                const c = document.getElementById(`pabc-conn-${i}`);
                if (c) c.className = 'pabc-connector done';
            }
            shark.classList.remove('running');
            currentSharkPhase = null;
            roadmap.classList.add('shimmer-out');
            setTimeout(() => roadmap.classList.remove('visible', 'shimmer-out'), 1000);
        } else {
            roadmap.classList.remove('shimmer-out');
            roadmap.classList.add('visible');
            shark.classList.add('running');

            const idx = ROADMAP_PHASES.indexOf(nextState as typeof ROADMAP_PHASES[number]);
            ROADMAP_PHASES.forEach((p, pi) => {
                const dot = document.getElementById(`dot-${p}`);
                if (dot) {
                    dot.className = `pabc-dot ${pi < idx ? 'done' : pi === idx ? 'active' : 'future'}`;
                    dot.setAttribute('data-phase', p);
                }
            });
            for (let i = 0; i < ROADMAP_PHASES.length; i++) {
                const c = document.getElementById(`pabc-conn-${i}`);
                if (c) c.className = `pabc-connector ${i < idx ? 'done' : ''}`;
            }

            currentSharkPhase = nextState;
            requestAnimationFrame(() => positionShark(roadmap, shark, nextState));
        }

        if (brand && title) {
            brand.textContent = title;
        }
    }
}

// ── SSE transport (Phase 3 — devlog 260609, 30 §5) ──
// event-channel delivers data-only payloads {…data, topic, event}; the adapter
// aliases event → type so the dispatcher below stays byte-identical to the
// original WS switch (30 §3 D-1). Since X-01, current servers publish public
// browser events via SSE only; the WebSocket leg below is client-side fallback
// for legacy servers where /api/events never opens.

let channelWired = false;
let snapshotReady: Promise<void> = Promise.resolve();
let orcStateEpoch = 0;

export function connect(): void {
    registerOrchestrateRestoreHooks();
    if (!channelWired) {
        channelWired = true;
        wireEventChannel();
    }
    // Silent-close any active fallback socket so SSE retry never double-transports
    // (devlog 260609, 31 — audit rules 1/3).
    closeLegacyWebSocket();
    connectEventChannel(getLang());
}

/** Re-establish the channel (e.g. locale change). Distinct name keeps boot-order
 *  source contracts (AB-003/HD-002) anchored on the single boot `connect();`. */
export const reopenChannel = connect;

function handleChannelUp(transport: 'sse' | 'ws'): void {
    console.log(`[${transport}] connected`);
    fallbackRetryDelayMs = 2000;
    clearChannelDownToastTimer(); // reconnected within grace — stay silent
    const now = Date.now();
    const skipReload = now - lastLoadTs < 10000;
    // 08 §6: orc_state events must wait for the snapshot fetch — keep the
    // whole hydration chain in snapshotReady so the orc_state gate can await it.
    snapshotReady = import('./ui.js').then(async m => {
        m.cleanupToolActivity();
        if (!skipReload) {
            try {
                await m.loadMessages();
                lastLoadTs = Date.now();
            } catch (error) {
                console.error(`[${transport}] loadMessages failed`, error);
            }
        }
        await syncOrchestrateSnapshot('reconnect', { hydrateRun: true })
            .catch(() => { /* snapshot not critical — UI recovers on next event */ })
            .finally(() => m.reconcileChatBottomAfterRestore('reconnect'));
        // X-01 (devlog 260609, 50): the server no longer pushes memory_status
        // on connect — hydrate the sidebar badge from REST instead.
        import('./features/memory.js')
            .then(mem => mem.refreshMemorySidebar())
            .catch(() => { /* badge hydrates on the next memory event */ });
        // bgtask badge: server pushes bgtask_update only on transitions —
        // hydrate the running set from REST after (re)connect.
        import('./features/bgtask-badge.js')
            .then(b => b.refreshBgtaskBadge())
            .catch(() => { /* hydrates on the next bgtask_update */ });
    });
}

function handleReplayGap(): void {
    showChatRestoreIndicator('replay_gap');
    snapshotReady = import('./ui.js').then(async m => {
        try {
            await m.loadMessages();
            lastLoadTs = Date.now();
        } catch (error) {
            console.error('[sse] replay gap loadMessages failed', error);
        }
        await syncOrchestrateSnapshot('replay_gap', { hydrateRun: true })
            .catch(() => { /* snapshot not critical — UI recovers on next event */ })
            .finally(() => m.reconcileChatBottomAfterRestore('replay_gap'));
    });
}

// Grace period before announcing a drop: SSE micro-drops auto-reconnect in
// ~2s with full lastEventId replay — the user loses nothing, so a toast on
// every blip reads as "끊김" spam while everything actually works. Only a
// persistent outage is worth announcing (and worth flipping the status pill).
const CHANNEL_DOWN_TOAST_GRACE_MS = 8000;
let channelDownToastTimer: number | null = null;

function clearChannelDownToastTimer(): void {
    if (channelDownToastTimer !== null) {
        window.clearTimeout(channelDownToastTimer);
        channelDownToastTimer = null;
    }
}

function handleChannelDown(): void {
    console.log('[channel] disconnected');
    import('./ui.js').then(m => m.cleanupToolActivity());
    if (channelDownToastTimer !== null) return; // earliest outage owns the deadline
    channelDownToastTimer = window.setTimeout(() => {
        channelDownToastTimer = null;
        setStatus('idle');
        addSystemMsg(`${ICONS.exec} ${t('ws.disconnected')}`, 'tool-activity');
    }, CHANNEL_DOWN_TOAST_GRACE_MS);
}

// ── Legacy WebSocket fallback (devlog 260609, 31) ──
// Old servers (pre-Phase 1) have no /api/events. When SSE has never connected
// and the stream errors, fall back to the legacy WS wire — its {type, ...data}
// payload is exactly what handleServerEvent expects, so handlers are shared.
// On WS close we retry connect() (SSE first): an upgraded server flips us back.

let legacyWs: WebSocket | null = null;
let legacySilentClose = false;
// Backoff for the never-opened case: against a NEW server whose /api/events
// failed transiently (503 SSE_CAPACITY, restart window) the WS leg can never
// open — a fixed 2s loop would hammer and spam. Reset on any channel-up.
let fallbackRetryDelayMs = 2000;
const FALLBACK_RETRY_MAX_MS = 30_000;

function closeLegacyWebSocket(): void {
    if (!legacyWs) return;
    legacySilentClose = true;
    try { legacyWs.close(); } catch { /* already closing */ }
    legacyWs = null;
}

function connectLegacyWebSocket(): void {
    if (legacyWs) return; // double-connect guard (31 audit rule 3)
    console.warn('[channel] /api/events unavailable — falling back to legacy WebSocket');
    const wsBase = import.meta.env?.DEV ? 'ws://localhost:3458' : `ws://${location.host}`;
    const ws = new WebSocket(`${wsBase}${API_BASE}/?lang=${getLang()}`);
    legacyWs = ws;
    legacySilentClose = false;
    ws.onmessage = (e: MessageEvent) => {
        let msg: WsMessage;
        try {
            msg = JSON.parse(e.data as string);
        } catch {
            console.warn('[ws] malformed message:', e.data);
            return;
        }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
            console.warn('[ws] invalid message shape:', msg);
            return;
        }
        handleServerEvent(msg);
    };
    let wsOpened = false;
    ws.onopen = () => {
        wsOpened = true;
        fallbackRetryDelayMs = 2000;
        handleChannelUp('ws');
    };
    ws.onclose = () => {
        if (legacyWs === ws) legacyWs = null;
        if (legacySilentClose) { legacySilentClose = false; return; } // intentional close — no side effects (31 audit rule 1)
        if (wsOpened) {
            // A real session dropped — old behavior: notify + quick retry.
            handleChannelDown();
            setTimeout(connect, 2000);
            return;
        }
        // Never opened: not a legacy server after all (or it's gone). No
        // channel transition happened, so skip the "disconnected" message
        // and back off — SSE is retried first on every connect().
        fallbackRetryDelayMs = Math.min(fallbackRetryDelayMs * 2, FALLBACK_RETRY_MAX_MS);
        setTimeout(connect, fallbackRetryDelayMs);
    };
}

function wireEventChannel(): void {
    subscribe('widget', 'widget_updated', (data) => {
        const chatId = data['chatId'];
        const widgetId = data['widgetId'];
        if (typeof chatId !== 'string' || typeof widgetId !== 'string') return;
        import('./diagram/iframe-renderer.js')
            .then(m => m.refreshFileWidget(chatId, widgetId))
            .catch(err => console.warn('[widget] refresh failed:', (err as Error).message));
    });
    subscribe('*', null, (data) => {
        const msg = { ...data, type: data['event'] } as unknown as WsMessage;
        handleServerEvent(msg);
    });
    onChannelOpen(() => handleChannelUp('sse'));
    onChannelDisconnect(() => handleChannelDown());
    onChannelUnavailable(() => connectLegacyWebSocket());
}

function handleServerEvent(msg: WsMessage): void {
    // Hot-path first (devlog 260705_frontend_perf M5): agent_tool/agent_output
    // arrive many times per second during streaming — they head the chain so
    // each event pays 1-2 string compares instead of walking cold branches.
    // Textual order agent_tool < agent_output < agent_retry is a test contract
    // (web-sse-replay-idempotency slices between those markers).
    if (msg.type === 'agent_tool') {
        if (isRecentSteer()) return;
        const toolRunId = typeof msg.traceRunId === 'string' && msg.traceRunId ? msg.traceRunId : null;
        const toolSeq = positiveSeq(msg.traceSeq);
        // SSE replay of a turn that already finalized: its steps live inside
        // the promoted history item — re-adding them would rebuild a second
        // process block on the live placeholder.
        if (isFinalizedRun(toolRunId)) return;
        if (shouldDropReplayedTool(toolRunId, toolSeq, msg.sseReplay === true)) return;
        // Employee mirror events carry the EMPLOYEE's run id — adopting it
        // would reset the boss text cursor and weaken replay protection
        // during interleave (260613 20 P2-i). Only boss tools adopt.
        if (msg.isEmployee !== true) adoptLiveRun(toolRunId);
        const stepType = msg.toolType === 'thinking' ? 'thinking'
            : msg.toolType === 'search' ? 'search'
                : msg.toolType === 'subagent' ? 'subagent' : 'tool';
        showProcessStep({
            id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: stepType,
            icon: msg.icon || ICONS.tool,
            rawIcon: msg.rawIcon || msg.icon || '',
            label: msg.label || '',
            isEmployee: msg.isEmployee === true,
            detail: msg.detail || '',
            stepRef: msg.stepRef || '',
            traceRunId: msg.traceRunId || '',
            traceSeq: msg.traceSeq,
            detailAvailable: msg.detailAvailable,
            detailBytes: msg.detailBytes,
            rawRetentionStatus: msg.rawRetentionStatus,
            status: (msg.status as 'running' | 'done' | 'error') || 'running',
            // Server run start beats client arrival time: the elapsed-timer origin
            // falls back to steps[0].startTime when pb.startedAt is lost on DOM
            // reconstruct, and an arrival-time origin resets it to ~0 (WP4b).
            startTime: typeof msg.startedAt === 'number' && msg.startedAt > 0 ? msg.startedAt : Date.now(),
        }, typeof msg.startedAt === 'number' && msg.startedAt > 0 ? msg.startedAt : undefined);
        rememberAppliedToolSeq(toolRunId, toolSeq);
    } else if (msg.type === 'agent_output' || msg.type === 'agent_chunk') {
        if (isRecentSteer()) return;
        const outputRunId = typeof msg.traceRunId === 'string' && msg.traceRunId ? msg.traceRunId : null;
        if (isFinalizedRun(outputRunId)) return; // replayed chunk of a finished turn
        adoptLiveRun(outputRunId);
        let outputText = msg.text || '';
        if (outputRunId && typeof msg.textLen === 'number') {
            // `textLen` is the server-side cumulative length AFTER this chunk.
            // At or below the applied cursor → the block already renders it
            // (SSE replay). A partial overlap appends only the unseen tail.
            if (msg.textLen <= liveAppliedTextLen) {
                // A LIVE chunk behind the cursor means cursor desync (snapshot
                // text and textLen share one accumulator — getSafeLiveRun).
                // Never freeze the stream on it: resync to the server's
                // cumulative length so the next chunk appends its tail, and
                // drop only this already-rendered content (260613 10 P1-b).
                if (msg.sseReplay !== true && msg.textLen < liveAppliedTextLen) {
                    console.warn(`[ws] live agent_output behind applied cursor — resync (${msg.textLen} < ${liveAppliedTextLen})`);
                    liveAppliedTextLen = msg.textLen;
                }
                return;
            }
            const missing = msg.textLen - liveAppliedTextLen;
            if (missing < outputText.length) outputText = outputText.slice(-missing);
            liveAppliedTextLen = msg.textLen;
        }
        appendAgentText(outputText);
    } else if (msg.type === 'agent_status') {
        if (!msg.running && isRecentSteer()) return;
        if (msg.running && isRecentSteer()) clearSteer();
        if (msg.running !== undefined) {
            setStatus(msg.running ? 'running' : 'idle');
        } else {
            setStatus(msg.status || 'idle');
        }
        // Track per-agent phase for badge rendering
        if (msg.agentId && msg.phase) {
            agentPhaseState[msg.agentId] = { phase: msg.phase, phaseLabel: msg.phaseLabel || '' };
            import('./features/employees.js').then(m => m.loadEmployees());
        }
    } else if (msg.type === 'bgtask_update') {
        import('./features/bgtask-badge.js').then(m => m.applyBgtaskUpdate(msg)).catch(() => {});
    } else if (msg.type === 'queue_update') {
        updateQueueBadge(msg.pending || 0);
        if (Array.isArray(msg.queued)) {
            renderPendingQueue(msg.queued);
        }
        syncOrchestrateSnapshot('queue_update').catch(() => { /* snapshot not critical — UI recovers on next event */ });
    } else if (msg.type === 'agent_retry') {
        const retryDelay = Number(msg.delay ?? 0);
        const retryReasonValue = (msg as WsMessage & { reason?: unknown }).reason;
        const retryReason = escapeHtml(String(retryReasonValue || '429'));
        const retryKey = retryDelay > 0 ? 'ws.retry' : 'ws.retryNow';
        addSystemMsg(t(retryKey, { cli: escapeHtml(msg.cli || ''), reason: retryReason, delay: retryDelay }), 'tool-activity');
    } else if (msg.type === 'agent_fallback') {
        addSystemMsg(t('ws.fallback', { from: escapeHtml(msg.from || ''), to: escapeHtml(msg.to || '') }), 'tool-activity');
    } else if (msg.type === 'agent_smoke') {
        addSystemMsg(`${ICONS.warning} ${escapeHtml(msg.cli || 'agent')}: smoke response detected — auto-continuing`, 'tool-activity');
    } else if (msg.type === 'goal_done') {
        state.activeGoal = null;
        renderGoalCockpit();
        addSystemMsg(`🎯 Goal completed${msg.source === 'ai_output' ? ' (detected from AI output)' : ''}`, 'tool-activity');
    } else if (msg.type === 'goal_cancel') {
        state.activeGoal = null;
        renderGoalCockpit();
        addSystemMsg(`🎯 Goal cancelled`, 'tool-activity');
    } else if (msg.type === 'schedule_wakeup') {
        addSystemMsg(`⏰ Wakeup scheduled in ${msg.delaySeconds}s — ${escapeHtml(String(msg.reason || ''))}`, 'tool-activity');
    } else if (msg.type === 'goal_continuation_limit') {
        addSystemMsg(`⚠️ Goal continuation limit reached (${msg.attempts} attempts)`, 'tool-activity');
    } else if (msg.type === 'goal_continuation') {
        addSystemMsg(`🎯 Active goal — auto-continuing`, 'tool-activity');
    } else if (msg.type === 'agent_done') {
        if (msg.steered || isRecentSteer()) {
            // Suppress agent_done from steered (killed) process.
            // Server sets steered:true; isRecentSteer is fallback for edge cases.
        } else {
            const doneRunId = typeof msg.traceRunId === 'string' && msg.traceRunId ? msg.traceRunId : null;
            // Replayed done of an already-finalized turn — drop, the history
            // item exists. A done carrying a DIFFERENT run id than the live
            // stream is a stale replay from a previous turn: finalizing here
            // froze the in-flight block mid-turn (260612 duplicate-block RCA).
            if (isFinalizedRun(doneRunId)) return;
            if (doneRunId && liveTraceRunId && doneRunId !== liveTraceRunId) return;
            markRunFinalized(doneRunId);
            finalizeAgent(msg.text || '', msg.toolLog);
            notifyUnreadResponse();
        }
    } else if (msg.type === 'orchestrate_done') {
        markRunFinalized(null);
        finalizeAgent(msg.text || '');
        notifyUnreadResponse();
    } else if (msg.type === 'clear') {
        cancelPostRender();
        cleanupToolActivity();
        getVirtualScroll().clear();
        const el = document.getElementById('chatMessages');
        if (el) el.innerHTML = '';
        // Intentional clear — also wipe this tab's cached history. The cache is keyed by
        // location and working directory, NOT by execution scope, so it clears its own
        // current scope rather than the one the event carries: passing the server's scope
        // here would name a key the cache has never written and delete nothing.
        // The tab only reaches this branch for a clear it owns, because the SSE filter
        // already dropped other sessions' clears upstream.
        import('./features/idb-cache.js').then(m => m.clearScopedCache()).catch(() => {});
    } else if (msg.type === 'session_reset') {
        addSystemMsg(`${ICONS.refresh} Session reset — history preserved`, 'tool-activity');
    } else if (msg.type === 'agent_added' || msg.type === 'agent_updated' || msg.type === 'agent_deleted') {
        import('./features/employees.js').then(m => m.loadEmployees());
    } else if (msg.type === 'heartbeat_pending') {
        const heartbeatRuntimePatch: Partial<HeartbeatRuntimeState> = {
            pending: msg.pending || 0,
            deferredPending: msg.deferredPending || 0,
        };
        if (msg.reason !== undefined) heartbeatRuntimePatch.reason = msg.reason;
        if (msg.policy !== undefined) heartbeatRuntimePatch.policy = msg.policy;
        if (msg.jobId !== undefined) heartbeatRuntimePatch.jobId = msg.jobId;
        if (msg.jobName !== undefined) heartbeatRuntimePatch.jobName = msg.jobName;
        applyHeartbeatRuntime(heartbeatRuntimePatch);
    } else if (msg.type === 'orc_state') {
        handleOrcStateGated(msg);
    } else if (msg.type === 'memory_status') {
        import('./features/memory.js').then(m => m.refreshMemorySidebar());
    } else if (msg.type === 'steer_started') {
        markSteered();
        markRunFinalized(null); // killed run — drop its replayed stream too
        finalizeAgent('');
        setStatus('steering');
    } else if (msg.type === 'new_message' && (msg.source === 'telegram' || msg.source === 'discord' || msg.source === 'slack' || msg.source === 'bgtask' || msg.source === 'cli' || msg.source === 'goal' || msg.external === true || msg.fromQueue === true)) {
        const newMessageRole = msg.role === 'assistant' ? 'agent' : (msg.role || 'user');
        const newMessageContent = msg.content || '';
        const newMessageCli = msg.cli;
        void import('./features/message-history.js').then(m => {
            if (m.historyReloadInFlight()) {
                // A snapshot rebuild is mid-flight (reconnect/restore reload):
                // appending now either gets wiped by the rebuild or lands out
                // of order against rows the snapshot already contains. Reload
                // after the flight settles — DB order wins over append order.
                void m.loadMessages()
                    .then(() => m.loadMessages())
                    .catch(err => console.warn('[ws] new_message reload after in-flight failed', err));
                return;
            }
            addMessage(newMessageRole, newMessageContent, newMessageCli);
        });
    } else if (msg.type === 'system_notice') {
        addSystemMsg(`ℹ️ ${escapeHtml(msg.text || '')}`, 'tool-activity');
    } else if (msg.type === 'replay_gap') {
        handleReplayGap();
    } else if (msg.type === 'worker_stalled') {
        addSystemMsg(`⚠️ Worker stalled: ${escapeHtml(msg.employeeName || msg.agentId || '')}`, 'tool-activity');
    } else if (msg.type === 'worker_disconnected') {
        addSystemMsg(`🔌 Worker disconnected: ${escapeHtml(msg.agentId || '')} (exit ${escapeHtml(String(msg.exitCode ?? '?'))})`, 'tool-activity');
    } else if (msg.type === 'worker_timeout') {
        addSystemMsg(`⏱️ Worker timed out: ${escapeHtml(msg.employeeName || msg.agentId || '')}`, 'tool-activity');
    } else if (msg.type === 'alert_escalation') {
        addSystemMsg(escapeHtml(msg.message || ''), 'tool-activity');
    } else if (msg.type === 'schedule_wakeup_failed') {
        addSystemMsg(`⚠️ Wakeup failed — ${escapeHtml(String(msg.reason || ''))}: ${escapeHtml(msg.error || '')}`, 'tool-activity');
    } else if (msg.type === 'goal_continuation_failed') {
        addSystemMsg(`⚠️ Goal continuation failed: ${escapeHtml(msg.error || '')}`, 'tool-activity');
    } else if (msg.type === 'settings_change') {
        handleSettingsChange(msg as { cli?: string; projectDirs?: string[] | null; changedKeys?: string[] });
    } else if (msg.type === 'session_list') {
        handleSessionListBroadcast(msg);
    } else if (msg.type === 'session_switched' || msg.type === 'session_created') {
        // Reload messages for the new active session
        window.location.reload();
    }
}

// 08 §6 + 감사 blocker 4: wait for the orchestrate snapshot before applying
// orc_state, and only apply the LATEST event after the await (epoch guard
// prevents stale events from racing ahead of newer ones).
function handleOrcStateGated(msg: WsMessage): void {
    const epoch = ++orcStateEpoch;
    void snapshotReady.then(() => {
        if (epoch !== orcStateEpoch) return;
        if (!shouldApplyOrcStateEvent(msg.scope, currentOrcScope)) return;
        applyOrcState(typeof msg.state === 'string' ? msg.state : 'IDLE', msg.title);
        applyOrcContext({
            taskAnchor: msg.taskAnchor || null,
            resolvedSelection: msg.resolvedSelection || null,
            interview: msg.interview || null,
        });
        renderBudgetPanel(msg.buildBudget || null, typeof msg.state === 'string' ? msg.state : 'IDLE');
    });
}

export function getAgentPhase(agentId: string): { phase: string; phaseLabel: string } | null {
    return agentPhaseState[agentId] || null;
}
