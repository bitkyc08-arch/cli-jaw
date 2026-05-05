// ── UI Utilities ──
import { state } from './state.js';
import { renderMarkdown, escapeHtml, sanitizeHtml, stripOrchestration, linkifyFilePaths } from './render.js';
import { renderMermaidBlocks } from './render.js';
import { generateId } from './uuid.js';
import { getAppName } from './features/appname.js';
import { getAgentAvatarMarkup, getUserAvatarMarkup } from './features/avatar.js';
import { t } from './features/i18n.js';
import { api } from './api.js';
import { cacheMessages, getCachedMessages, appendCachedMessage, upsertMessage, setMessageScope, getScopedMessages } from './features/idb-cache.js';
import { getVirtualScroll, VS_THRESHOLD, type RestoreReason, type VirtualItem } from './virtual-scroll.js';
import { bootstrapVirtualHistory, type VirtualHistoryBootstrapDeps } from './virtual-scroll-bootstrap.js';
import { createStreamRenderer, appendChunk, finalizeStream, hydrateStreamRenderer, type StreamState } from './streaming-render.js';
import { activateWidgets } from './diagram/iframe-renderer.js';
import { renderLiveToolActivity, cleanupToolElements, bindToolItemInteractions, type ToolLogEntry } from './features/tool-ui.js';
import { ICONS, emojiToIcon, emojiToStatus, isCompletionEmoji } from './icons.js';
import { providerIcon } from './provider-icons.js';
import { findRunningProcessStepMatch } from './features/process-step-match.js';
import {
    parseToolLogBounded,
    sanitizeToolLogForDurableStorage,
    serializeSanitizedToolLog,
    type SanitizedToolLogEntry,
} from '../../src/shared/tool-log-sanitize.js';
import {
    createProcessBlock,
    addStep,
    replaceStep,
    updateStepStatus,
    collapseBlock,
    stopBlockTicker,
    buildProcessBlockHtml,
    bindProcessBlockInteractions,
    getStoredProcessStepDetail,
    mergeStoredProcessStepDetail,
    processStepMetaFromStore,
    releaseProcessBlockDetails,
    type ProcessStep,
    type ProcessBlockState,
} from './features/process-block.js';
interface MessageItem { role: string; content: string; tool_log?: string | null; cli?: string | null; }
interface QueuedOverlayItem { id: string; prompt: string; source?: string; ts?: number; }
interface ActiveRunSnapshot { running?: boolean; cli?: string; text?: string; toolLog?: ToolLogEntry[]; startedAt?: number; }

function processStepType(toolType?: string): ProcessStep['type'] {
    return toolType === 'thinking' || toolType === 'search' || toolType === 'subagent'
        ? toolType
        : 'tool';
}

function processStepStatus(status?: string): ProcessStep['status'] {
    return status === 'running' || status === 'done' || status === 'error' ? status : 'done';
}

function fallbackToolLabel(tool: ToolLogEntry): string {
    if (tool.label) return tool.label;
    const named = tool as ToolLogEntry & { name?: unknown };
    return typeof named.name === 'string' && named.name ? named.name : 'tool';
}

function parseToolLog(toolLog?: string | null): ToolLogEntry[] {
    return parseToolLogBounded(toolLog) as ToolLogEntry[];
}

function sanitizedToolLogJson(toolLog?: string | null): string | null {
    return serializeSanitizedToolLog(parseToolLog(toolLog));
}

function normalizeMessageToolLog<T extends MessageItem>(message: T): T {
    if (message.role !== 'assistant' || !message.tool_log) return { ...message, tool_log: null };
    return { ...message, tool_log: sanitizedToolLogJson(message.tool_log) };
}

function getAgentIcon(_cli?: string | null): string {
    return getAgentAvatarMarkup();
}

function toProcessSteps(tools: ToolLogEntry[], runStartedAt?: number): ProcessStep[] {
    const baseTime = runStartedAt && runStartedAt > 0 ? runStartedAt : Date.now();
    return tools.map((tool) => ({
        id: generateId(),
        icon: tool.icon ? emojiToIcon(tool.icon) : ICONS.tool,
        rawIcon: tool.rawIcon || tool.icon || '',
        label: fallbackToolLabel(tool),
        type: processStepType(tool.toolType),
        detail: tool.detail || '',
        stepRef: tool.stepRef || '',
        status: processStepStatus(tool.status),
        startTime: baseTime,
    }));
}

const TOOL_BLOCK_SELECTOR =
    ':scope > .process-block, :scope > .tool-group, ' +
    ':scope > .msg-content > .process-block, :scope > .msg-content > .tool-group';

function agentBody(agentMsg: HTMLElement): HTMLElement | null {
    return agentMsg.querySelector('.agent-body') as HTMLElement | null;
}

function agentToolBlocks(agentMsg: HTMLElement): HTMLElement[] {
    const body = agentBody(agentMsg);
    return body ? Array.from(body.querySelectorAll<HTMLElement>(TOOL_BLOCK_SELECTOR)) : [];
}

function preferredAgentToolBlock(body: HTMLElement): HTMLElement | null {
    const content = body.querySelector(':scope > .msg-content') as HTMLElement | null;
    return body.querySelector(':scope > .process-block')
        ?? body.querySelector(':scope > .tool-group')
        ?? content?.querySelector(':scope > .process-block')
        ?? content?.querySelector(':scope > .tool-group')
        ?? null;
}

function normalizeAgentToolBlocks(agentMsg: HTMLElement): void {
    const body = agentBody(agentMsg);
    if (!body) return;

    const content = body.querySelector('.msg-content') as HTMLElement | null;
    const blocks = agentToolBlocks(agentMsg);
    if (blocks.length === 0) return;

    const keep = preferredAgentToolBlock(body) ?? blocks[0];
    if (content && keep.parentElement !== body) {
        body.insertBefore(keep, content);
    }

    for (const block of blocks) {
        if (block !== keep) {
            releaseProcessBlockDetails(block);
            block.remove();
        }
    }
}

function hasAgentToolBlock(agentMsg: HTMLElement): boolean {
    return agentToolBlocks(agentMsg).length > 0;
}

function processStepTypeFromDom(type?: string): ProcessStep['type'] {
    return type === 'thinking' || type === 'search' || type === 'subagent'
        ? type
        : 'tool';
}

function processStepStatusFromDom(status?: string): ProcessStep['status'] {
    return status === 'done' || status === 'error' ? status : 'running';
}

function processStepFromDom(row: HTMLElement): ProcessStep | null {
    const id = row.dataset['stepId'] || '';
    if (!id) return null;
    const storedMeta = processStepMetaFromStore(id);
    const label = row.querySelector('.process-step-label')?.textContent?.trim() || '';
    const pre = row.querySelector('.process-step-full') as HTMLElement | null;
    const detail = pre?.dataset['detailLazy'] === 'true'
        ? getStoredProcessStepDetail(id) || storedMeta?.preview || ''
        : pre?.textContent || getStoredProcessStepDetail(id) || storedMeta?.preview || '';
    const iconEl = row.querySelector('.process-step-icon') as HTMLElement | null;
    const icon = iconEl?.innerHTML || ICONS.tool;
    const startTime = Number(row.dataset['startTime'] || '');
    return {
        id,
        type: storedMeta?.type || processStepTypeFromDom(row.dataset['type']),
        icon: storedMeta?.icon || icon,
        rawIcon: storedMeta?.rawIcon,
        label: storedMeta?.label || label,
        detail,
        detailPreview: storedMeta?.preview,
        detailLength: storedMeta?.detailLength,
        detailTruncated: storedMeta?.detailTruncated,
        stepRef: storedMeta?.stepRef || row.dataset['stepRef'] || '',
        status: storedMeta?.status || processStepStatusFromDom(row.dataset['status']),
        startTime: Number.isFinite(startTime) && startTime > 0 ? startTime : Date.now(),
    };
}

function currentProcessBlockFromDom(agentMsg: HTMLElement): ProcessBlockState | null {
    const block = agentBody(agentMsg)?.querySelector(':scope > .process-block') as HTMLElement | null;
    if (!block) return null;
    const steps = Array.from(block.querySelectorAll<HTMLElement>('.process-step'))
        .map(processStepFromDom)
        .filter((step): step is ProcessStep => Boolean(step));
    return {
        element: block,
        steps,
        collapsed: block.classList.contains('collapsed'),
    };
}

function processStepToToolLog(step: ProcessStep, finalize = false): ToolLogEntry {
    const detail = getStoredProcessStepDetail(step.id) || step.detail || step.detailPreview || '';
    const status = finalize && step.status === 'running' ? 'done' : step.status;
    return {
        icon: step.rawIcon || step.icon || ICONS.tool,
        rawIcon: step.rawIcon || step.icon || '',
        label: step.label || 'tool',
        detail,
        toolType: step.type,
        stepRef: step.stepRef || '',
        status,
    };
}

function processStepFromMeta(stepId: string, finalize = false): ToolLogEntry | null {
    const meta = processStepMetaFromStore(stepId);
    if (!meta) return null;
    const status = finalize && meta.status === 'running' ? 'done' : meta.status;
    return {
        icon: meta.rawIcon || meta.icon || ICONS.tool,
        rawIcon: meta.rawIcon || meta.icon || '',
        label: meta.label || 'tool',
        detail: getStoredProcessStepDetail(stepId) || meta.preview || '',
        toolType: meta.type,
        stepRef: meta.stepRef || '',
        status,
    };
}

function serializeProcessStepsForToolLog(source: ProcessBlockState | HTMLElement | null, finalize = false): ToolLogEntry[] {
    if (!source) return [];
    if ('steps' in source) return source.steps.map(step => processStepToToolLog(step, finalize));

    const ids = new Set<string>();
    source.querySelectorAll<HTMLElement>('.process-block[data-process-step-ids]').forEach(block => {
        (block.dataset['processStepIds'] || '').split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
    });
    source.querySelectorAll<HTMLElement>('.process-step[data-step-id]').forEach(row => {
        const id = row.dataset['stepId'];
        if (id) ids.add(id);
    });
    const entries: ToolLogEntry[] = [];
    ids.forEach(id => {
        const fromMeta = processStepFromMeta(id, finalize);
        if (fromMeta) {
            entries.push(fromMeta);
            return;
        }
        const row = source.querySelector<HTMLElement>(`.process-step[data-step-id="${CSS.escape(id)}"]`);
        const step = row ? processStepFromDom(row) : null;
        if (step) entries.push(processStepToToolLog(step, finalize));
    });
    return entries;
}

function identityKey(entry: ToolLogEntry, ordinal: number): string {
    const stepRef = String(entry.stepRef || '').trim();
    if (stepRef) return `ref:${stepRef}`;
    return `ord:${entry.toolType || 'tool'}:${entry.label || 'tool'}:${ordinal}`;
}

function mergeExplicitAndLiveToolLogs(explicit: ToolLogEntry[], live: ToolLogEntry[]): ToolLogEntry[] {
    if (explicit.length === 0) return live;
    const merged = new Map<string, ToolLogEntry>();
    const ordinalCounts = new Map<string, number>();
    const keyFor = (entry: ToolLogEntry): string => {
        const base = `${entry.toolType || 'tool'}:${entry.label || 'tool'}`;
        const next = (ordinalCounts.get(base) || 0) + 1;
        ordinalCounts.set(base, next);
        return identityKey(entry, next);
    };
    live.forEach(entry => merged.set(keyFor(entry), entry));
    ordinalCounts.clear();
    explicit.forEach(entry => {
        const key = keyFor(entry);
        const liveEntry = merged.get(key);
        const liveDetail = liveEntry?.detail || '';
        const explicitDetail = entry.detail || '';
        merged.set(key, {
            ...(liveEntry || {}),
            ...entry,
            detail: explicitDetail.length >= liveDetail.length ? explicitDetail : liveDetail,
            status: entry.status || liveEntry?.status || 'done',
        });
    });
    return Array.from(merged.values());
}

function sanitizedToolLogEntries(entries: ToolLogEntry[]): ToolLogEntry[] {
    return sanitizeToolLogForDurableStorage(entries) as ToolLogEntry[];
}

function sanitizedToolLogJsonFromEntries(entries: ToolLogEntry[]): string | null {
    return serializeSanitizedToolLog(entries);
}


function removeAgentToolBlocks(agentMsg: HTMLElement): void {
    for (const block of agentToolBlocks(agentMsg)) {
        releaseProcessBlockDetails(block);
        block.remove();
    }
}

export function setStatus(s: string): void {
    const badge = document.getElementById('statusBadge');
    const btn = document.getElementById('btnSend');
    state.agentBusy = s === 'running';
    document.getElementById('typingIndicator')?.classList.toggle('active', state.agentBusy);
    if (s === 'running') {
        if (badge) { badge.className = 'status-badge status-running'; badge.textContent = 'running'; }
        if (btn) { btn.innerHTML = ICONS.stop; btn.title = t('btn.stop'); btn.classList.add('stop-mode'); }
        showSkeleton();
    } else {
        if (badge) { badge.className = 'status-badge status-idle'; badge.textContent = 'idle'; }
        if (btn) { btn.innerHTML = ICONS.send; btn.title = 'Send'; btn.classList.remove('stop-mode'); }
        removeSkeleton();
    }
}

export function updateQueueBadge(count: number): void {
    let el = document.getElementById('queueBadge');
    if (!el) {
        el = document.createElement('span');
        el.id = 'queueBadge';
        el.className = 'queue-badge';
        const sendBtn = document.getElementById('btnSend');
        if (sendBtn?.parentElement) sendBtn.parentElement.style.position = 'relative';
        if (sendBtn) { sendBtn.style.position = 'relative'; sendBtn.appendChild(el); }
    }
    el.textContent = count > 0 ? String(count) : '';
    el.style.display = count > 0 ? 'flex' : 'none';
}

function showSkeleton(): void {
    const container = document.getElementById('chatMessages');
    if (!container || container.querySelector('.skeleton-msg')) return;
    if (state.currentAgentDiv && state.currentAgentDiv.isConnected) return;
    // No flushToDOM — skeleton goes directly into container as overlay
    hideEmptyState();
    const skel = document.createElement('div');
    skel.className = 'skeleton-msg';
    skel.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div>';
    container.appendChild(skel);
    scrollToBottom();
}

function removeSkeleton(): void {
    document.querySelectorAll('.skeleton-msg').forEach(el => el.remove());
}

function hideEmptyState(): void {
    document.getElementById('emptyState')?.classList.remove('visible');
}

function showEmptyState(): void {
    const container = document.getElementById('chatMessages');
    if (container && container.children.length === 0) {
        document.getElementById('emptyState')?.classList.add('visible');
    }
}

export function addSystemMsg(text: string, extraClass?: string, type?: string): void {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const vs = getVirtualScroll();
    hideEmptyState();
    const div = document.createElement('div');
    const typeClass = type ? ` msg-type-${type}` : '';
    div.className = 'msg msg-system' + typeClass + (extraClass ? ' ' + extraClass : '');
    div.innerHTML = sanitizeHtml(text);
    if (vs.active) {
        vs.appendLiveItem(div);
    } else {
        container.appendChild(div);
    }
    scrollToBottom();
}

export function cleanupToolActivity(): void {
    if (state.currentProcessBlock) releaseProcessBlockDetails(state.currentProcessBlock);
    if (state.currentAgentDiv instanceof HTMLElement) releaseProcessBlockDetails(state.currentAgentDiv);
    cleanupToolElements();
    stopBlockTicker();
    state.currentAgentDiv = null;
    state.currentProcessBlock = null;
    currentStream = null;
}

export function showLiveToolActivity(label: string): void {
    removeSkeleton();
    if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
        state.currentAgentDiv = addMessage('agent', '');
    }
    renderLiveToolActivity(state.currentAgentDiv as HTMLElement, label);
    scrollToBottom();
}

export function showProcessStep(step: ProcessStep): void {
    removeSkeleton();
    if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
        state.currentAgentDiv = addMessage('agent', '');
        state.currentProcessBlock = null;
    }
    const agentDiv = state.currentAgentDiv;
    normalizeAgentToolBlocks(agentDiv);
    if (!state.currentProcessBlock) {
        const body = agentDiv.querySelector('.agent-body') as HTMLElement;
        if (body) {
            state.currentProcessBlock = currentProcessBlockFromDom(agentDiv);
        }
        if (!state.currentProcessBlock && body) {
            removeAgentToolBlocks(agentDiv);
            state.currentProcessBlock = createProcessBlock(body);
        }
    }
    if (state.currentProcessBlock) {
        const rawIcon = step.rawIcon || step.icon;
        // Completion detection: prefer semantic status field, fall back to emoji check
        const resolvedStatus = (step.status && step.status !== 'running')
            ? step.status
            : emojiToStatus(step.icon);
        if (resolvedStatus === 'done' || resolvedStatus === 'error') {
            // Prefer matching by stepRef (stable correlation), fall back to label
            const match = findRunningProcessStepMatch(state.currentProcessBlock.steps, step);
            if (match) {
                step.icon = emojiToIcon(step.icon);
                const mergedPreview = mergeStoredProcessStepDetail(match.id, step.detail);
                replaceStep(state.currentProcessBlock, match.id, {
                    ...match,
                    ...step,
                    id: match.id,
                    rawIcon,
                    detail: mergedPreview,
                    detailPreview: mergedPreview,
                    label: step.label || match.label,
                    status: resolvedStatus,
                });
                scrollToBottom();
                return;
            }
            if (step.stepRef && (resolvedStatus === 'done' || resolvedStatus === 'error')) {
                const existingDone = [...state.currentProcessBlock.steps].reverse()
                    .find(s => s.stepRef === step.stepRef && (s.status === 'done' || s.status === 'error'));
                if (existingDone) {
                    step.icon = emojiToIcon(step.icon);
                    replaceStep(state.currentProcessBlock, existingDone.id, {
                        ...existingDone,
                        ...step,
                        id: existingDone.id,
                        rawIcon,
                        status: resolvedStatus,
                        detail: mergeStoredProcessStepDetail(existingDone.id, step.detail),
                    });
                    scrollToBottom();
                    return;
                }
            }
        }
        // Dedupe: detail이 있는 재broadcast → 같은 label+type의 detail 없는 유령 교체
        if (step.detail) {
            const ghost = [...state.currentProcessBlock.steps].reverse()
                .find(s => s.status === 'running'
                    && s.label === step.label
                    && s.type === step.type
                    && !s.detail);
            if (ghost) {
                replaceStep(state.currentProcessBlock, ghost.id, step);
                scrollToBottom();
                return;
            }
        }
        // Convert emoji icon to SVG before adding step
        step.rawIcon = rawIcon;
        step.icon = emojiToIcon(step.icon);
        addStep(state.currentProcessBlock, step);
    }
    scrollToBottom();
}

let currentStream: StreamState | null = null;

const ACTIVE_RUN_HYDRATED_ATTR = 'data-active-run-hydrated';

function removeStaleHydratedActiveRuns(keep?: HTMLElement | null): void {
    document.querySelectorAll<HTMLElement>(`[${ACTIVE_RUN_HYDRATED_ATTR}="true"]`).forEach(el => {
        if (keep && el === keep) return;
        el.remove();
    });
}

function ensureActiveRunMessage(cli?: string | null): HTMLElement {
    const existing = state.currentAgentDiv && state.currentAgentDiv.isConnected
        ? state.currentAgentDiv as HTMLElement
        : null;
    removeStaleHydratedActiveRuns(existing);
    const div = existing || addMessage('agent', '', cli || null);
    div.setAttribute(ACTIVE_RUN_HYDRATED_ATTR, 'true');
    return div;
}

/**
 * Queued items are surfaced exclusively by the pending-queue panel
 * (renderPendingQueue) — they do NOT appear as chat bubbles until they
 * actually start running. This function exists only to clean up legacy
 * overlay bubbles from older builds that may still be in the DOM after
 * a soft reload, and to drop stale snapshots silently.
 */
export function applyQueuedOverlay(_items: QueuedOverlayItem[] = []): void {
    document.querySelectorAll('[data-queued-overlay="true"]').forEach(el => el.remove());
}

export function hydrateActiveRun(snapshot?: ActiveRunSnapshot | null): void {
    if (!snapshot?.running) {
        removeStaleHydratedActiveRuns();
        return;
    }
    cleanupToolElements();
    removeSkeleton();
    state.currentAgentDiv = ensureActiveRunMessage(snapshot.cli || null);
    state.currentProcessBlock = null;
    const body = state.currentAgentDiv.querySelector('.agent-body') as HTMLElement | null;
    const snapshotToolLog = sanitizedToolLogEntries(snapshot.toolLog || []);
    if (body && snapshotToolLog.length) {
        normalizeAgentToolBlocks(state.currentAgentDiv);
        removeAgentToolBlocks(state.currentAgentDiv);
        const pb = createProcessBlock(body);
        for (const tool of toProcessSteps(snapshotToolLog, snapshot.startedAt)) addStep(pb, tool);
        state.currentProcessBlock = pb;
    } else {
        normalizeAgentToolBlocks(state.currentAgentDiv);
        state.currentProcessBlock = currentProcessBlockFromDom(state.currentAgentDiv);
    }
    const content = state.currentAgentDiv.querySelector('.msg-content') as HTMLElement | null;
    if (content) {
        currentStream = hydrateStreamRenderer(content, snapshot.text || '');
    }
}

export function appendAgentText(text: string): void {
    if (!text) return;
    removeSkeleton();
    if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
        state.currentAgentDiv = addMessage('agent', '');
        currentStream = null;
    }
    const content = (state.currentAgentDiv as HTMLElement)?.querySelector('.msg-content');
    if (content) {
        if (!currentStream) currentStream = createStreamRenderer(content as HTMLElement);
        appendChunk(currentStream, text);
    }
    scrollToBottom();
}

let lastFinalizeTs = 0;

function clearMermaidTransientState(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('.mermaid-pending').forEach(el => {
        delete el.dataset['mermaidQueued'];
        delete el.dataset['mermaidQueuedAt'];
    });
}

export function finalizeAgent(text: string, toolLog?: ToolLogEntry[]): void {
    // Guard: prevent double-render when both agent_done + orchestrate_done fire
    const now = Date.now();
    if (!state.currentAgentDiv && now - lastFinalizeTs < 500) return;

    cleanupToolElements();
    removeSkeleton();
    if (state.currentAgentDiv) normalizeAgentToolBlocks(state.currentAgentDiv);
    const liveToolLog = serializeProcessStepsForToolLog(
        state.currentProcessBlock ?? state.currentAgentDiv,
        true,
    );
    const explicitToolLog = Array.isArray(toolLog) ? toolLog : [];
    const durableToolLog = sanitizedToolLogEntries(
        mergeExplicitAndLiveToolLogs(explicitToolLog, liveToolLog),
    );
    const durableToolLogJson = sanitizedToolLogJsonFromEntries(durableToolLog);
    const hadProcessBlock =
        Boolean(state.currentProcessBlock) ||
        Boolean(state.currentAgentDiv && hasAgentToolBlock(state.currentAgentDiv));
    if (state.currentProcessBlock) {
        collapseBlock(state.currentProcessBlock);
        state.currentProcessBlock = null;
    }
    const hasTools = durableToolLog.length > 0;
    if (text || hasTools) {
        if (!state.currentAgentDiv || !state.currentAgentDiv.isConnected) {
            state.currentAgentDiv = addMessage('agent', '');
        }
        state.currentAgentDiv.removeAttribute(ACTIVE_RUN_HYDRATED_ATTR);
        const content = (state.currentAgentDiv as HTMLElement)?.querySelector('.msg-content');
        // Live stream is preview-only; agent_done text stays authoritative.
        const streamedText = currentStream ? finalizeStream(currentStream, true) : '';
        const finalText = text || streamedText;
        currentStream = null;
        if (content) content.innerHTML = renderMarkdown(finalText);
        if (hasTools && state.currentAgentDiv && !hadProcessBlock && !hasAgentToolBlock(state.currentAgentDiv)) {
            const contentEl = state.currentAgentDiv.querySelector('.msg-content') as HTMLElement | null;
            if (contentEl) {
                contentEl.insertAdjacentHTML(
                    'beforebegin',
                    buildProcessBlockHtml(toProcessSteps(durableToolLog), true),
                );
            }
        }
        if (state.currentAgentDiv) normalizeAgentToolBlocks(state.currentAgentDiv);
        if (content) content.setAttribute('data-raw', stripOrchestration(finalText));
        if (content) activateWidgets(content as HTMLElement);

        const vs = getVirtualScroll();
        const willPromoteToVirtualScroll = !!(
            vs.active && state.currentAgentDiv && state.currentAgentDiv.isConnected
        );

        // Phase 127-F5/F9: kick off mermaid render immediately for direct DOM only.
        // If this message will be promoted into Virtual Scroll, let the mounted VS
        // clone render via onPostRender; otherwise we can queue a soon-detached node.
        if (content && !willPromoteToVirtualScroll) {
            void renderMermaidBlocks(content as HTMLElement, { immediate: true });
        }

        // Promote streaming div from real DOM into VS if active.
        // Revert activated widgets back to pending state so VS can
        // re-activate them after recreating the DOM from stored HTML.
        if (willPromoteToVirtualScroll) {
            const div = state.currentAgentDiv;
            clearMermaidTransientState(div);
            div.querySelectorAll('.diagram-widget').forEach(widget => {
                const encoded = (widget as HTMLElement).dataset['widgetHtml'];
                if (!encoded) return;
                const pending = document.createElement('div');
                pending.className = 'diagram-widget-pending';
                pending.dataset['diagramHtml'] = encoded;
                widget.replaceWith(pending);
            });
            if (durableToolLogJson) {
                vs.appendItem(buildLazyVirtualMessageItem({
                    role: 'assistant',
                    content: finalText,
                    cli: null,
                    tool_log: durableToolLogJson,
                }));
                releaseProcessBlockDetails(div);
            } else {
                vs.appendLiveItem(div);
            }
            div.remove();
        }

        // Cache agent response for offline (use finalText to capture stream-only responses)
        if (finalText) upsertMessage({
            role: 'assistant',
            content: finalText,
            tool_log: durableToolLogJson,
            timestamp: Date.now(),
        }).catch(() => {});
    }
    currentStream = null;
    state.currentAgentDiv = null;
    lastFinalizeTs = Date.now();
    setStatus('idle');
    loadStats();
}

/** Convert server-stored prompts back to display format on reload.
 *  Handles: file uploads, multi-file, voice+file combos (ko + en patterns) */
function formatUserPrompt(text: string): string {
    // Multi-file: "[사용자가 파일 3개를 보냈습니다]" or "[User sent 3 files]"
    const multiMatch = text.match(/^\[(?:사용자가 파일 (\d+)개를 보냈습니다|User sent (\d+) files)\]/);
    if (multiMatch) {
        const count = multiMatch[1] || multiMatch[2];
        const userMsgMatch = text.match(/(?:사용자 메시지|User message): (.+)$/s);
        const userMsg = userMsgMatch ? ' ' + userMsgMatch[1].trim() : '';
        return `📎 [${count} files]${userMsg}`;
    }

    // Single file: "[사용자가 파일을 보냈습니다: /path/to/file.md]"
    const fileMatch = text.match(/^\[(?:사용자가 파일을 보냈습니다|User sent a file): ([^\]]+)\]/);
    if (fileMatch) {
        const fileName = fileMatch[1].split('/').pop() || fileMatch[1];
        // Check if voice is also present (🎤 after file block)
        const voiceMatch = text.match(/🎤\s*(.{0,80})/);
        const voicePart = voiceMatch ? `${t('chat.voice.label')} ` : '';
        const userMsgMatch = text.match(/(?:사용자 메시지|User message): (.+)$/s);
        const userMsg = userMsgMatch ? ' ' + userMsgMatch[1].trim() : '';
        return `${voicePart}📎 [${fileName}]${userMsg}`;
    }

    return text;
}

export function addMessage(role: string, text: string, cli?: string | null): HTMLDivElement {
    const container = document.getElementById('chatMessages');
    const vs = getVirtualScroll();
    hideEmptyState();
    removeSkeleton();

    // For user messages: convert file-upload prompts to clean display format
    const displayText = role === 'user' ? formatUserPrompt(text) : text;
    const rendered = renderMarkdown(displayText);
    const label = escapeHtml(role === 'user' ? t('msg.you') : getAppName());

    const div = document.createElement('div');
    if (role === 'agent') {
        div.className = 'msg msg-agent';
        div.innerHTML = `<div class="agent-icon" aria-hidden="true">${getAgentIcon(cli)}</div><div class="agent-body"><div class="msg-content">${rendered}</div><button class="msg-copy" title="Copy" aria-label="Copy message"></button></div>`;
    } else {
        div.className = `msg msg-${role}`;
        div.innerHTML = `<div class="user-body"><div class="msg-label">${label}</div><div class="msg-content">${rendered}</div><button class="msg-copy" title="Copy" aria-label="Copy message"></button></div><div class="user-icon" aria-hidden="true">${getUserAvatarMarkup()}</div>`;
    }
    const contentEl = div.querySelector('.msg-content');
    if (contentEl) contentEl.setAttribute('data-raw', stripOrchestration(text));

    // Streaming placeholder (agent + empty text) must stay in real DOM
    // so state.currentAgentDiv reference remains valid during streaming.
    const isStreamingPlaceholder = role === 'agent' && !text;

    if (vs.active && !isStreamingPlaceholder) {
        if (div.classList.contains('msg-agent')) normalizeAgentToolBlocks(div);
        vs.appendLiveItem(div);
    } else {
        container?.appendChild(div);
        activateWidgets(div);

        // Check if live growth crossed threshold — activate VS
        if (!vs.active && !isStreamingPlaceholder && container) {
            const msgCount = container.querySelectorAll('.msg').length;
            if (msgCount >= VS_THRESHOLD) {
                // Feed all existing DOM messages into VS items array
                container.querySelectorAll('.msg').forEach(el => {
                    if (el.classList.contains('msg-agent')) normalizeAgentToolBlocks(el as HTMLElement);
                    vs.addItem(generateId(), el.outerHTML);
                });
                // Wire widget activation + file path linkification for VS-rendered items
                vs.onPostRender = (viewport: HTMLElement) => {
                    activateWidgets(viewport);
                    linkifyFilePaths(viewport);
                    // Phase 127-F7b: render mermaid in newly mounted VS viewport
                    void renderMermaidBlocks(viewport, { immediate: true });
                };
            }
        }
    }
    // Force scroll for user messages so they're always visible after sending;
    // agent/system messages respect the user's current scroll position.
    scrollToBottom(role === 'user');
    return div;
}

let scrollRAF: number | null = null;
let userNearBottom = true;
let scrollTrackingBound = false;
const SCROLL_BOTTOM_THRESHOLD = 80; // px
const RESTORE_INDICATOR_SETTLE_MS = 1100;
let chatRestoreIndicatorHideTimer: number | null = null;

function ensureScrollTracking(): void {
    if (scrollTrackingBound) return;
    const c = document.getElementById('chatMessages');
    if (!c) return;
    scrollTrackingBound = true;
    c.addEventListener('scroll', () => {
        const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
        userNearBottom = dist < SCROLL_BOTTOM_THRESHOLD;
    }, { passive: true });
}

export function isChatNearBottom(): boolean {
    ensureScrollTracking();
    const c = document.getElementById('chatMessages');
    if (!c) return userNearBottom;
    const vs = getVirtualScroll();
    if (vs.active) return vs.isNearBottom(SCROLL_BOTTOM_THRESHOLD);
    const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
    return dist < SCROLL_BOTTOM_THRESHOLD;
}

export function reconcileChatBottomAfterLayout(shouldFollow = isChatNearBottom()): void {
    ensureScrollTracking();
    if (!shouldFollow) return;
    userNearBottom = true;
    const vs = getVirtualScroll();
    if (vs.active) {
        vs.reconcileBottomAfterLayout('reconnect', true);
        return;
    }
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const c = document.getElementById('chatMessages');
            if (c) c.scrollTop = c.scrollHeight;
        });
    });
}

export function showChatRestoreIndicator(reason: string): void {
    if (chatRestoreIndicatorHideTimer !== null) {
        window.clearTimeout(chatRestoreIndicatorHideTimer);
        chatRestoreIndicatorHideTimer = null;
    }
    const host = document.querySelector('.chat-area') as HTMLElement | null;
    if (!host) return;
    let indicator = host.querySelector('[data-restore-indicator="true"]') as HTMLElement | null;
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'chat-restore-indicator';
        indicator.setAttribute('data-restore-indicator', 'true');
        indicator.setAttribute('role', 'status');
        indicator.setAttribute('aria-live', 'polite');
        indicator.innerHTML = '<span class="chat-restore-dot"></span><span class="chat-restore-text">Restoring</span>';
        host.appendChild(indicator);
    }
    indicator.dataset['restoreReason'] = reason;
}

export function hideChatRestoreIndicator(): void {
    if (chatRestoreIndicatorHideTimer !== null) {
        window.clearTimeout(chatRestoreIndicatorHideTimer);
        chatRestoreIndicatorHideTimer = null;
    }
    document.querySelectorAll('[data-restore-indicator="true"]').forEach(el => el.remove());
}

export function hideChatRestoreIndicatorAfterSettle(delayMs = RESTORE_INDICATOR_SETTLE_MS): void {
    if (chatRestoreIndicatorHideTimer !== null) {
        window.clearTimeout(chatRestoreIndicatorHideTimer);
    }
    chatRestoreIndicatorHideTimer = window.setTimeout(() => {
        chatRestoreIndicatorHideTimer = null;
        hideChatRestoreIndicator();
    }, delayMs);
}

export function reconcileChatBottomAfterRestore(reason: string): void {
    showChatRestoreIndicator(reason);
    hideChatRestoreIndicatorAfterSettle();
    ensureScrollTracking();
    userNearBottom = true;
    const vs = getVirtualScroll();
    if (vs.active) {
        vs.forceBottomAfterRestore(reason as RestoreReason);
        return;
    }
    const scroll = () => {
        const c = document.getElementById('chatMessages');
        if (c) c.scrollTop = c.scrollHeight;
    };
    scroll();
    requestAnimationFrame(scroll);
    requestAnimationFrame(() => requestAnimationFrame(scroll));
    window.setTimeout(scroll, 250);
    window.setTimeout(scroll, 1000);
    void document.fonts?.ready.then(scroll);
}

/** Scroll chat to bottom.
 *  @param force - bypass user-scroll detection (use for explicit user actions) */
export function scrollToBottom(force = false): void {
    ensureScrollTracking();
    if (!force && !userNearBottom) return;
    // After force scroll, mark as near-bottom so subsequent
    // streaming chunks keep auto-scrolling until user scrolls up
    if (force) userNearBottom = true;

    const vs = getVirtualScroll();
    if (vs.active) {
        vs.scrollToBottom();
        return;
    }
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
        scrollRAF = null;
        const c = document.getElementById('chatMessages');
        if (c) c.scrollTop = c.scrollHeight;
    });
}

export function switchTab(name: string, targetBtn: Element): void {
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const tabMap: Record<string, string> = { agents: 'tabAgents', settings: 'tabSettings', skills: 'tabSkills' };
    document.getElementById(tabMap[name])?.classList.add('active');
    if (targetBtn) {
        targetBtn.classList.add('active');
        targetBtn.setAttribute('aria-selected', 'true');
    }
    // Lazy-load tab content
    if (name === 'settings') { import('./features/settings.js').then(m => m.loadSettings()); }
    if (name === 'agents') { import('./features/employees.js').then(m => m.loadEmployees()); }
    if (name === 'skills') { import('./features/skills.js').then(m => m.loadSkills()); }
}

export function handleSave(): void {
    const isSettings = document.getElementById('tabSettings')?.classList.contains('active');
    if (isSettings) {
        import('./features/settings.js').then(m => m.savePerCli());
    } else {
        import('./features/settings.js').then(m => m.updateSettings());
    }
}

function updateStatMsgs(count: number): void {
    const el = document.getElementById('statMsgs');
    if (el) el.textContent = t('stat.messages', { count });
}

export async function loadStats(): Promise<void> {
    const msgs = await api<MessageItem[]>('/api/messages');
    if (!msgs) return;
    updateStatMsgs(msgs.length);
}

// ── Virtual scroll bootstrap helpers ──

function buildLazyVirtualMessageItem(m: MessageItem): VirtualItem {
        const role = m.role === 'assistant' ? 'agent' : m.role;
        const rawContent = stripOrchestration(
            role === 'user' ? formatUserPrompt(m.content) : m.content,
        );
        const label = escapeHtml(role === 'user' ? t('msg.you') : getAppName());
        const sanitizedToolLog = m.role === 'assistant' && m.tool_log
            ? sanitizedToolLogJson(m.tool_log)
            : null;
        const rawToolLog = sanitizedToolLog ? escapeHtml(sanitizedToolLog) : '';
        const toolAttr = rawToolLog ? ` data-tool-log="${rawToolLog}"` : '';
        const contentHtml = `<div class="msg-content lazy-pending" data-raw="${escapeHtml(rawContent)}"></div>`;
        const html = role === 'agent'
            ? `<div class="msg msg-agent"><div class="agent-icon" aria-hidden="true">${getAgentIcon(m.cli)}</div><div class="agent-body"${toolAttr}>${contentHtml}<button class="msg-copy" title="Copy" aria-label="Copy message"></button></div></div>`
            : `<div class="msg msg-${role}"><div class="user-body"><div class="msg-label">${label}</div>${contentHtml}<button class="msg-copy" title="Copy" aria-label="Copy message"></button></div><div class="user-icon" aria-hidden="true">${getUserAvatarMarkup()}</div></div>`;
        return { id: generateId(), html, height: 80, rehydratesProcessDetails: Boolean(rawToolLog) };
}

function buildVirtualHistoryItems(msgs: MessageItem[]): VirtualItem[] {
    return msgs.map((m) => buildLazyVirtualMessageItem(normalizeMessageToolLog(m)));
}

function registerVirtualScrollCallbacks(vs: ReturnType<typeof getVirtualScroll>): void {
    vs.onLazyRender = (targets: HTMLElement[]) => {
        for (const el of targets) {
            if (!el.classList.contains('lazy-pending')) continue;
            const raw = el.getAttribute('data-raw') || '';
            const msgEl = el.closest('.msg-agent') as HTMLElement | null;
            const body = msgEl?.querySelector('.agent-body') as HTMLElement | null;
            const rawToolLog = body?.dataset['toolLog'] || '';
            if (msgEl && body && rawToolLog && !hasAgentToolBlock(msgEl)) {
                const tools = parseToolLog(rawToolLog);
                if (tools.length > 0) {
                    el.insertAdjacentHTML(
                        'beforebegin',
                        buildProcessBlockHtml(toProcessSteps(tools), true),
                    );
                }
                delete body.dataset['toolLog'];
                normalizeAgentToolBlocks(msgEl);
            }
            el.innerHTML = raw ? renderMarkdown(raw) : '';
            el.classList.remove('lazy-pending');
            activateWidgets(el);
            // Phase 127-F7a: lazy-rendered blocks (fresh markdown just converted)
            void renderMermaidBlocks(el, { immediate: true });
        }
    };
    vs.onPostRender = (viewport: HTMLElement) => {
        activateWidgets(viewport);
        linkifyFilePaths(viewport);
        // Phase 127-F7b: mounted viewport scope — handles VS items that arrive
        // pre-rendered with .mermaid-pending (buildVirtualHistoryItems path,
        // addMessage append path). These are NOT .lazy-pending so F7a misses them.
        void renderMermaidBlocks(viewport, { immediate: true });
    };
}

function makeBootstrapDeps(
    vs: ReturnType<typeof getVirtualScroll>,
): VirtualHistoryBootstrapDeps {
    return {
        registerCallbacks: () => registerVirtualScrollCallbacks(vs),
        setItems: (items, opts) => vs.setItems(items, opts),
        activateIfNeeded: (toBottom) => vs.activateIfNeeded(toBottom),
        scrollToBottom: () => vs.scrollToBottom(),
    };
}

export async function loadMessages(): Promise<void> {
    const vs = getVirtualScroll();
    const chatEl = document.getElementById('chatMessages');

    // Set scope from server workingDir (localStorage fallback if server is down)
    try {
        const settings = await api<{ workingDir?: string }>('/api/settings');
        if (settings?.workingDir) setMessageScope(settings.workingDir);
    } catch { /* localStorage fallback already initialized currentScope */ }

    const msgs = await api<MessageItem[]>('/api/messages');

    if (msgs !== null) {
        const safeMsgs = msgs.map(normalizeMessageToolLog);
        // Successful fetch — clear DOM and render (even if empty array after /clear)
        vs.clear();
        if (chatEl) chatEl.innerHTML = '';

        if (safeMsgs.length >= VS_THRESHOLD) {
            const vsItems = buildVirtualHistoryItems(safeMsgs);
            bootstrapVirtualHistory(vsItems, makeBootstrapDeps(vs));
        } else {
            safeMsgs.forEach(m => {
                const div = addMessage(m.role === 'assistant' ? 'agent' : m.role, m.content, m.cli);
                if (m.role === 'assistant') {
                    const tools = parseToolLog(m.tool_log);
                    if (tools.length > 0) {
                        const body = div.querySelector('.agent-body') as HTMLElement;
                        if (body) {
                            const pb = createProcessBlock(body);
                            for (const tool of toProcessSteps(tools)) addStep(pb, tool);
                            collapseBlock(pb);
                        }
                    }
                }
            });
        }
        // Sync to IndexedDB (full replace — server is source of truth)
        cacheMessages(safeMsgs.map(m => ({
            role: m.role, content: m.content, cli: m.cli ?? null, tool_log: m.tool_log ?? null, timestamp: Date.now(),
        }))).catch(() => {});
        updateStatMsgs(safeMsgs.length);
        showEmptyState();
        return;
    }

    // Server unreachable (api() returned null) — preserve existing DOM messages
    if (chatEl && chatEl.children.length > 0) {
        showEmptyState();
        return;
    }
    // DOM empty + server down — try IndexedDB cache
    const cached = await getScopedMessages();
    if (cached.length > 0) {
        const safeCached = (cached as MessageItem[]).map(normalizeMessageToolLog);
        if (safeCached.length >= VS_THRESHOLD) {
            const vsItems = buildVirtualHistoryItems(safeCached);
            bootstrapVirtualHistory(vsItems, makeBootstrapDeps(vs));
        } else {
            safeCached.forEach(m => {
                const div = addMessage(m.role === 'assistant' ? 'agent' : m.role, m.content, m.cli);
                if (m.role === 'assistant' && m.tool_log) {
                    const tools = parseToolLog(m.tool_log);
                    if (tools.length > 0) {
                        const body = div.querySelector('.agent-body') as HTMLElement;
                        if (body) {
                            const pb = createProcessBlock(body);
                            for (const tool of toProcessSteps(tools)) addStep(pb, tool);
                            collapseBlock(pb);
                        }
                    }
                }
            });
        }
        addSystemMsg(`${ICONS.warning} ${t('ui.offline.banner')}`);
        updateStatMsgs(safeCached.length);
    }
    showEmptyState();
}

// loadMemory removed — #memoryList element does not exist in HTML.
// Memory is now handled by features/memory.ts via the modal UI.

// ── Message copy delegation ──
export function initMsgCopy(): void {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    bindProcessBlockInteractions(chatMessages);
    bindToolItemInteractions(chatMessages);
    chatMessages.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;

        // Tool group toggle (event delegation instead of inline onclick)
        const summary = target.closest('.tool-group-summary') as HTMLElement | null;
        if (summary) {
            const group = summary.closest('.tool-group');
            const details = summary.nextElementSibling as HTMLElement;
            if (group && details) {
                const isExpanding = !group.classList.contains('expanded');
                group.classList.toggle('expanded');
                details.classList.toggle('collapsed');
                summary.setAttribute('aria-expanded', isExpanding ? 'true' : 'false');
            }
            return;
        }

        // Message copy
        const btn = target.closest('.msg-copy') as HTMLElement | null;
        if (!btn) return;
        const msg = btn.closest('.msg');
        const content = msg?.querySelector('.msg-content') as HTMLElement | null;
        if (!content) return;
        const text = content.getAttribute('data-raw') || content.innerText || content.textContent || '';
        navigator.clipboard.writeText(text).then(() => {
            btn.classList.add('copied');
            btn.innerHTML = ICONS.checkSimple;
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = '';
            }, 600);
        }).catch(() => { });
    });
}
