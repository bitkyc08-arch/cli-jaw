// ── WebSocket Connection ──
import { state } from './state.js';
import { setStatus, updateQueueBadge, addSystemMsg, appendAgentText, finalizeAgent, addMessage, showProcessStep, cleanupToolActivity, applyQueuedOverlay, hydrateActiveRun, reconcileChatBottomAfterRestore, showChatRestoreIndicator } from './ui.js';
import { renderPendingQueue } from './features/pending-queue.js';
import { t, getLang } from './features/i18n.js';
import { getVirtualScroll } from './virtual-scroll.js';
import { ICONS, emojiToIcon } from './icons.js';
import { escapeHtml, cancelPostRender } from './render.js';
import type { HeartbeatRuntimeState, OrcStateName, ResolvedSelectionState } from './state.js';
import { notifyUnreadResponse } from './features/attention-badge.js';
import { shouldApplyOrcStateEvent } from './features/orchestrate-scope.js';

const ROADMAP_PHASES = ['P', 'A', 'B', 'C'] as const;

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
        shark.style.left = (mid - barRect.left - sharkW / 2) + 'px';
    } else {
        const dotRect = dot.getBoundingClientRect();
        shark.style.left = (dotRect.left - barRect.left + dotRect.width / 2 - sharkW / 2) + 'px';
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
    path?: string;
    round?: number;
    agentPhases?: { agent?: string; name?: string }[];
    subtasks?: { agent?: string; name?: string }[];
    action?: string;
    icon?: string;
    label?: string;
    toolType?: string;
    detail?: string;
    stepRef?: string;
    text?: string;
    toolLog?: { icon: string; label: string; detail?: string; toolType?: string; stepRef?: string }[];
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
    reason?: HeartbeatRuntimeState['reason'];
    policy?: HeartbeatRuntimeState['policy'];
    jobId?: string;
    jobName?: string;
    deferredPending?: number;
    taskAnchor?: string | null;
    resolvedSelection?: ResolvedSelectionState | null;
}

// Agent phase state (populated by agent_status events from orchestrator)
const agentPhaseState: Record<string, { phase: string; phaseLabel: string }> = {};

let currentOrcScope = '';
let lastLoadTs = 0;
let snapshotSyncInFlight: Promise<void> | null = null;
let lastSnapshotSyncAt = 0;
let restoreHooksRegistered = false;
const SNAPSHOT_SYNC_THROTTLE_MS = 750;

async function refreshRuntimeSnapshot(options: { hydrateRun?: boolean } = {}): Promise<void> {
    const response = await fetch('/api/orchestrate/snapshot');
    const snap = await response.json();
    currentOrcScope = String(snap.orc.scope || '');
    applyOrcState(snap.orc.state);
    applyOrcContext(snap.orc.ctx || null);
    applyHeartbeatRuntime(snap.heartbeat || { pending: 0, deferredPending: 0 });
    hydrateAgentPhases(snap.workers);
    updateQueueBadge(snap.runtime.queuePending);
    applyQueuedOverlay(snap.queued || []);
    renderPendingQueue(snap.queued || []);
    if (options.hydrateRun) hydrateActiveRun(snap.activeRun);
    setStatus(snap.runtime.busy ? 'running' : 'idle');
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

function syncAfterBrowserRestore(reason: string): void {
    showChatRestoreIndicator(reason);
    syncOrchestrateSnapshot(reason)
        .finally(() => {
            reconcileChatBottomAfterRestore(reason);
        })
        .catch(() => {});
}

function registerOrchestrateRestoreHooks(): void {
    if (restoreHooksRegistered) return;
    restoreHooksRegistered = true;
    window.addEventListener('focus', () => {
        syncAfterBrowserRestore('focus');
    });
    window.addEventListener('pageshow', () => {
        syncAfterBrowserRestore('pageshow');
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            syncAfterBrowserRestore('visibilitychange');
        }
    });
    document.addEventListener('resume', () => {
        syncAfterBrowserRestore('resume');
    });
    if ('wasDiscarded' in document
        && Boolean((document as Document & { wasDiscarded?: boolean }).wasDiscarded)) {
        syncAfterBrowserRestore('discard');
    }
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

function applyOrcContext(ctx: { taskAnchor?: string | null; resolvedSelection?: ResolvedSelectionState | null } | null): void {
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
}

/** Apply orchestration state to UI (shared by WS events and reconnect snapshot) */
function applyOrcState(orcState: string, title?: string) {
    const allowed = new Set<OrcStateName>(['IDLE', 'P', 'A', 'B', 'C', 'D']);
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
            IDLE: '', P: 'PLAN', A: 'AUDIT', B: 'BUILD', C: 'CHECK', D: 'DONE',
        };
        badge.textContent = labels[nextState];
        badge.style.display = nextState === 'IDLE' ? 'none' : 'inline-block';
    }

    // ─── Roadmap Bar ───
    const roadmap = document.getElementById('pabcRoadmap');
    const shark = document.getElementById('sharkRunner');
    const brand = document.getElementById('pabcBrand');

    if (roadmap && shark) {
        if (!roadmap.dataset.resizeObserved) {
            roadmap.dataset.resizeObserved = '1';
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
            for (let i = 0; i < 4; i++) {
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
            for (let i = 0; i < 4; i++) {
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

export function connect(): void {
    registerOrchestrateRestoreHooks();
    const wsBase = import.meta.env?.DEV ? 'ws://localhost:3458' : `ws://${location.host}`;
    state.ws = new WebSocket(`${wsBase}?lang=${getLang()}`);
    state.ws.onmessage = (e: MessageEvent) => {
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
        if (msg.type === 'agent_status') {
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
        } else if (msg.type === 'queue_update') {
            updateQueueBadge(msg.pending || 0);
            syncOrchestrateSnapshot('queue_update').catch(() => { /* snapshot not critical — UI recovers on next event */ });
        } else if (msg.type === 'worklog_created') {
            addSystemMsg(`${ICONS.clipboard} Worklog: ${escapeHtml(msg.path || '')}`);
        } else if (msg.type === 'round_start') {
            const agents = (msg.agentPhases || msg.subtasks || []);
            const names = agents.map(a => escapeHtml(a.agent || a.name || '')).join(', ');
            addSystemMsg(t('ws.roundStart', { round: msg.round || 0, count: agents.length, names }));
        } else if (msg.type === 'round_done') {
            if (msg.action === 'complete') {
                addSystemMsg(t('ws.roundDone', { round: msg.round || 0 }));
            } else if (msg.action === 'next') {
                addSystemMsg(t('ws.roundNext', { round: msg.round || 0 }));
            } else {
                addSystemMsg(t('ws.roundRetry', { round: msg.round || 0 }));
            }
        } else if (msg.type === 'agent_tool') {
            const empPrefix = msg.isEmployee ? '(E) ' : '';
            const stepType = msg.toolType === 'thinking' ? 'thinking'
                : msg.toolType === 'search' ? 'search'
                    : msg.toolType === 'subagent' ? 'subagent' : 'tool';
            showProcessStep({
                id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: stepType,
                icon: msg.icon || ICONS.tool,
                rawIcon: (msg as any).rawIcon || msg.icon || '',
                label: empPrefix + (msg.label || ''),
                detail: msg.detail || '',
                stepRef: msg.stepRef || '',
                status: (msg.status as 'running' | 'done' | 'error') || 'running',
                startTime: Date.now(),
            });
        } else if (msg.type === 'agent_output') {
            appendAgentText(msg.text || '');
        } else if (msg.type === 'agent_retry') {
            addSystemMsg(t('ws.retry', { cli: escapeHtml(msg.cli || ''), delay: msg.delay || 10 }), 'tool-activity');
        } else if (msg.type === 'agent_fallback') {
            addSystemMsg(t('ws.fallback', { from: escapeHtml(msg.from || ''), to: escapeHtml(msg.to || '') }), 'tool-activity');
        } else if (msg.type === 'agent_smoke') {
            addSystemMsg(`${ICONS.warning} ${escapeHtml(msg.cli || 'agent')}: smoke response detected — auto-continuing`, 'tool-activity');
        } else if (msg.type === 'agent_done') {
            finalizeAgent(msg.text || '', msg.toolLog);
            notifyUnreadResponse();
        } else if (msg.type === 'orchestrate_done') {
            finalizeAgent(msg.text || '');
            notifyUnreadResponse();
        } else if (msg.type === 'clear') {
            cancelPostRender();
            cleanupToolActivity();
            getVirtualScroll().clear();
            const el = document.getElementById('chatMessages');
            if (el) el.innerHTML = '';
            // Intentional clear — also wipe IndexedDB cache
            import('./features/idb-cache.js').then(m => m.clearCache()).catch(() => {});
        } else if (msg.type === 'session_reset') {
            addSystemMsg(`${ICONS.refresh} Session reset — history preserved`, 'tool-activity');
        } else if (msg.type === 'agent_added' || msg.type === 'agent_updated' || msg.type === 'agent_deleted') {
            import('./features/employees.js').then(m => m.loadEmployees());
        } else if (msg.type === 'heartbeat_pending') {
            applyHeartbeatRuntime({
                pending: msg.pending || 0,
                deferredPending: msg.deferredPending || 0,
                reason: msg.reason,
                policy: msg.policy,
                jobId: msg.jobId,
                jobName: msg.jobName,
            });
        } else if (msg.type === 'orc_state') {
            if (!shouldApplyOrcStateEvent(msg.scope, currentOrcScope)) return;
            applyOrcState(typeof msg.state === 'string' ? msg.state : 'IDLE', msg.title);
            applyOrcContext({
                taskAnchor: msg.taskAnchor || null,
                resolvedSelection: msg.resolvedSelection || null,
            });
        } else if (msg.type === 'memory_status') {
            import('./features/memory.js').then(m => m.refreshMemorySidebar());
        } else if (msg.type === 'new_message' && (msg.source === 'telegram' || msg.source === 'discord' || msg.fromQueue === true)) {
            // fromQueue=true: backend just drained a queued message (processQueue or steer route)
            // → render user bubble now (chat.ts dropped the optimistic one at enqueue time).
            addMessage(msg.role === 'assistant' ? 'agent' : (msg.role || 'user'), msg.content || '', msg.cli);
        }
    };
    state.ws.onopen = () => {
        console.log('[ws] connected');
        const now = Date.now();
        const skipReload = now - lastLoadTs < 10000;
        import('./ui.js').then(async m => {
            m.cleanupToolActivity();
            if (!skipReload) {
                try {
                    await m.loadMessages();
                    lastLoadTs = Date.now();
                } catch (error) {
                    console.error('[ws] loadMessages failed', error);
                }
            }
            syncOrchestrateSnapshot('reconnect', { hydrateRun: true })
                .catch(() => { /* snapshot not critical — UI recovers on next WS event */ })
                .finally(() => m.reconcileChatBottomAfterRestore('reconnect'));
        });
    };
    state.ws.onclose = () => {
        console.log('[ws] disconnected, reconnecting in 2s...');
        import('./ui.js').then(m => m.cleanupToolActivity());
        setStatus('idle');
        addSystemMsg(`${ICONS.exec} 연결 끊김 — 재연결 중...`, 'tool-activity');
        setTimeout(connect, 2000);
    };
}

export function getAgentPhase(agentId: string): { phase: string; phaseLabel: string } | null {
    return agentPhaseState[agentId] || null;
}
