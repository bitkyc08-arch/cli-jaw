import { api } from '../api.js';
import { renderMarkdown, linkifyFilePathsWithNotesRoot } from '../render.js';
import { renderMermaidBlocks } from '../render.js';
import { getVirtualScroll, VS_THRESHOLD, type VirtualItem } from '../virtual-scroll.js';
import { bootstrapVirtualHistory, type VirtualHistoryBootstrapDeps } from '../virtual-scroll-bootstrap.js';
import { activateWidgets } from '../diagram/iframe-renderer.js';
import { ICONS } from '../icons.js';
import { hydrateElicitationBlocks } from './elicitation.js';
import { hydrateSearchResultsBlocks } from '../render/search-results.js';
import { hydrateComposeBlocks } from '../render/compose-block.js';
import { hydrateDataframeBlocks } from '../render/dataframe.js';
import { hydrateChartJsonBlocks } from '../render/chart-json.js';
import { hydrateLinkPreviewCards } from '../render/link-preview.js';
import { t } from './i18n.js';
import { cacheMessages, getMessageScope, getScopedMessages, setMessageScope, type CachedMessage } from './idb-cache.js';
import { addMessage, addSystemMsg, showEmptyState } from './chat-messages.js';
import { buildLazyVirtualMessageItem } from './message-item-html.js';
import { addStep, buildProcessBlockHtml, collapseBlock, createProcessBlock } from './process-block.js';
import { hasAgentToolBlock, normalizeAgentToolBlocks } from './process-block-dom.js';
import { normalizeMessageToolLog, parseToolLog, toProcessSteps, type MessageItem } from './process-log-adapter.js';
import { canFollowAfterRestore, ensureScrollTracking, markFollowingBottom, settleChatBottomAfterInitialLoad } from './chat-scroll.js';
import { updateStatMsgs } from './ui-status.js';
import { seedCompletedElicitationsFromMessages } from './elicitation-state.js';
import { withCurrentSessionQuery, currentSessionId } from './session-hub.js';
import { remountLiveActivity, recycleActivityHost } from './activity-live.js';
import { prepareActivityTranscript, setActivityTranscript, observeActivityHistory, recycleActivityHistory } from './activity-history.js';

const activityVirtualHooks = {
    postRender(root: HTMLElement) { remountLiveActivity(root); observeActivityHistory(root); },
    recycle(message: HTMLElement) { recycleActivityHistory(message); recycleActivityHost(message); },
};

/** Live promotion may bypass history bootstrap; preserve every installed callback. */
export function ensureActivityVirtualCallbacks(vs: ReturnType<typeof getVirtualScroll>): void {
    vs.addLifecycleHooks(activityVirtualHooks);
}

export function buildVirtualHistoryItems(msgs: MessageItem[]): VirtualItem[] {
    return msgs.map((m, index) => buildLazyVirtualMessageItem(normalizeMessageToolLog(m), index));
}

// 260613 06/50 5b: the virtual scroll retains every loaded message's rendered
// HTML for the tab's lifetime — a full-history load made `items[]` the largest
// client allocation in long sessions. The server supports a recent-window
// (`routes/messages.ts ?limit=`, capped 5000); 3000 keeps weeks of scrollback
// while bounding the heap. Old servers ignore the param (full history).
// Mid-session appends stay uncapped on purpose: dropping the oldest item
// would shift every vsIdx/height index; each reload/restore re-applies the
// window instead.
const BOOT_MESSAGE_WINDOW = 3000;

export function bootMessageQuery(): string {
    return withCurrentSessionQuery(`?limit=${BOOT_MESSAGE_WINDOW}`);
}

function normalizeMessageScopePart(value: string | null | undefined): string {
    return String(value || '').trim() || 'unknown';
}

export function buildMessageLocationKey(input: { origin?: string; pathname?: string | null }): string {
    const origin = normalizeMessageScopePart(input.origin);
    const pathname = normalizeMessageScopePart(input.pathname || '/');
    return `${origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

export function buildMessageScopeIdentity(input: { locationKey?: string; workingDir?: string | null }): string {
    return `${normalizeMessageScopePart(input.locationKey)}::${normalizeMessageScopePart(input.workingDir)}`;
}

function readCurrentMessageLocationKey(): string {
    if (typeof window === 'undefined') return buildMessageLocationKey({});
    return buildMessageLocationKey({
        origin: window.location.origin,
        pathname: window.location.pathname,
    });
}

function readWorkingDirFromScope(scope: string): string | null {
    if (!scope || scope === 'default') return null;
    const markerIndex = scope.indexOf('::');
    return markerIndex >= 0 ? scope.slice(markerIndex + 2) : scope;
}

export function registerVirtualScrollCallbacks(vs: ReturnType<typeof getVirtualScroll>): void {
    vs.onLazyRender ??= (targets: HTMLElement[]) => {
        for (const el of targets) {
            if (!el.classList.contains('lazy-pending')) continue;
            const raw = el.getAttribute('data-raw') || '';
            const msgEl = el.closest('.msg-agent') as HTMLElement | null;
            const body = msgEl?.querySelector('.agent-body') as HTMLElement | null;
            const rawToolLog = body?.dataset['toolLog'] || '';
            if (msgEl && body && rawToolLog && !hasAgentToolBlock(msgEl)) {
                const tools = parseToolLog(rawToolLog);
                if (tools.length > 0) {
                    el.insertAdjacentHTML('beforebegin', buildProcessBlockHtml(toProcessSteps(tools), true));
                }
                delete body.dataset['toolLog'];
                normalizeAgentToolBlocks(msgEl);
            }
            el.innerHTML = raw ? renderMarkdown(raw) : '';
            el.classList.remove('lazy-pending');
            activateWidgets(el);
            hydrateElicitationBlocks(el);
            hydrateSearchResultsBlocks(el);
            hydrateComposeBlocks(el);
            hydrateDataframeBlocks(el);
            hydrateChartJsonBlocks(el);
            hydrateLinkPreviewCards(el);
            void renderMermaidBlocks(el, { immediate: true });
        }
    };
    vs.onPostRender ??= (viewport: HTMLElement) => {
        activateWidgets(viewport);
        hydrateElicitationBlocks(viewport);
        hydrateSearchResultsBlocks(viewport);
        hydrateComposeBlocks(viewport);
        hydrateDataframeBlocks(viewport);
        hydrateChartJsonBlocks(viewport);
        hydrateLinkPreviewCards(viewport);
        void linkifyFilePathsWithNotesRoot(viewport);
        void renderMermaidBlocks(viewport, { immediate: true });
    };
    ensureActivityVirtualCallbacks(vs);
}

export function makeBootstrapDeps(
    vs: ReturnType<typeof getVirtualScroll>,
    options: { forceInitialBottom?: boolean; restoreIndex?: number | null } = {},
): VirtualHistoryBootstrapDeps {
    const shouldFollowBottom = options.forceInitialBottom ? () => true : canFollowAfterRestore;
    return {
        registerCallbacks: () => registerVirtualScrollCallbacks(vs),
        setItems: (items, opts) => vs.setItems(items, opts),
        activateIfNeeded: (toBottom) => vs.activateIfNeeded(toBottom),
        scrollToBottom: () => vs.scrollToBottom(),
        scrollToIndex: (index) => vs.scrollToIndex(index),
        shouldFollowBottom,
        restoreIndex: options.restoreIndex ?? null,
        onBeforeVirtualHistoryBootstrap: () => { ensureScrollTracking(); },
        onAfterVirtualHistoryBottomed: () => {
            markFollowingBottom();
            settleChatBottomAfterInitialLoad();
        },
    };
}

function hydrateSmallHistory(messages: MessageItem[]): void {
    messages.forEach(m => {
        const div = addMessage(m.role === 'assistant' ? 'agent' : m.role, m.content, m.cli);
        if (m.id !== undefined) div.dataset['messageId'] = String(m.id);
        if (m.trace_run_id) div.dataset['traceRunId'] = m.trace_run_id;
        if (m.session_id !== undefined) div.dataset['messageSessionId'] = m.session_id;
        if (m.server_message_id !== undefined) {
            div.dataset['serverMessageId'] = String(m.server_message_id); div.dataset['activitySaved'] = 'true';
        }
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

function cachedToMessage(message: CachedMessage): MessageItem {
    const cachedId = message.message_id ?? message.id;
    return {
        ...(cachedId !== undefined ? { id: cachedId } : {}),
        role: message.role,
        content: message.content,
        cli: message.cli ?? null,
        tool_log: message.tool_log ?? null,
        trace_run_id: message.trace_run_id ?? null,
        ...(message.session_id === undefined ? {} : { session_id: message.session_id }),
        ...(typeof message.message_id === 'number' && Number.isSafeInteger(message.message_id) && message.message_id > 0
            ? { server_message_id: message.message_id } : {}),
    };
}

// Signature of the last rendered history. Channel reconnects re-run
// loadMessages even when nothing changed — skipping the teardown+rebuild
// keeps the virtual scroll (and the user's reading position) untouched.
let lastRenderedSignature = '';

function historySignature(scope: string, msgs: MessageItem[]): string {
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return `${scope}|${msgs.length}|${last ? JSON.stringify(last) : ''}`;
}

// preview instance-switch remounts can fire the boot
// channel-up reload and the onLoad visibility-ping reload concurrently.
// Without single-flight they both clear+bootstrap the virtual scroll and the
// newest rows can stay lazy-pending. Concurrent callers join the same load.
let loadMessagesInFlight: Promise<void> | null = null;
let loadMessagesKey = '', loadGeneration = 0;
let loadController: AbortController | null = null;
let renderedView = '', renderedSession: string | null = null;
let renderedRuns = new Set<string>();

export async function loadMessages(): Promise<void> {
    const requestedSession = currentSessionId();
    const key = `${readCurrentMessageLocationKey()}:${requestedSession ?? ''}`;
    if (loadMessagesKey === key) {
        if (loadMessagesInFlight) return loadMessagesInFlight;
    }
    loadController?.abort(); const controller = new AbortController(); loadController = controller;
    loadMessagesKey = key; const generation = ++loadGeneration;
    const path = `/api/messages${bootMessageQuery()}&withSession=1`;
    prepareActivityTranscript();
    const timer = setTimeout(() => controller.abort(new DOMException('Message history deadline', 'TimeoutError')), 30_000);
    const current = () => generation === loadGeneration
        && key === `${readCurrentMessageLocationKey()}:${currentSessionId() ?? ''}`;
    const work = loadMessagesOnce({ requestedSession, key, path, signal: controller.signal,
        current: () => !controller.signal.aborted && current(),
    }).catch(error => {
        if (!controller.signal.aborted) throw error;
    }).finally(() => {
        clearTimeout(timer);
        if (loadMessagesInFlight === work) { loadMessagesInFlight = null; loadController = null; }
        // Release only this view's suspension; an older cancellation cannot resume
        // a newer load or grant identity to an unverified cache result.
        if (controller.signal.aborted && current()) {
            setActivityTranscript(renderedView === key ? renderedSession : null,
                renderedView === key ? renderedRuns : new Set());
        }
    });
    loadMessagesInFlight = work; return work;
}

/** True while a history snapshot fetch/rebuild is mid-flight. A live append
 *  during this window races the rebuild — the fetched snapshot may not
 *  contain the row yet, and the rebuild wipes whatever was appended, so the
 *  row is lost or lands out of order. Callers should reload after the
 *  in-flight load settles instead of appending. */
export function historyReloadInFlight(): boolean {
    return loadMessagesInFlight !== null;
}

interface MessageReadContext {
    requestedSession: string | null; key: string; path: string; signal: AbortSignal; current(): boolean;
}

/** HTTP and IndexedDB share the loader's deadline, even when a source ignores abort. */
async function readMessageSource<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([read(), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
}

function parseMessageSnapshot(raw: unknown, requested: string | null): { sessionId: string | null; messages: MessageItem[] } {
    let sessionId = requested, rows: unknown;
    if (Array.isArray(raw)) rows = raw; // Older server: explicit requested session only.
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const value = raw as Record<string, unknown>;
        if (typeof value['sessionId'] !== 'string' || !value['sessionId'] || value['sessionId'].length > 240
            || requested !== null && value['sessionId'] !== requested) throw new Error('message_session_mismatch');
        sessionId = value['sessionId']; rows = value['messages'];
    }
    if (!Array.isArray(rows)) throw new Error('invalid_message_snapshot');
    const messages = rows.slice(-BOOT_MESSAGE_WINDOW).map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_message_snapshot');
        const record = value as Record<string, unknown>;
        if (typeof record['role'] !== 'string' || typeof record['content'] !== 'string'
            || (record['id'] !== undefined && !(typeof record['id'] === 'number' && Number.isSafeInteger(record['id']) && record['id'] > 0)
                && !(typeof record['id'] === 'string' && record['id'].length <= 240))
            || (record['trace_run_id'] != null && !(typeof record['trace_run_id'] === 'string' && record['trace_run_id'].length <= 240))
            || (record['session_id'] !== undefined && !(typeof record['session_id'] === 'string' && record['session_id'].length > 0 && record['session_id'].length <= 240))
            || (sessionId && record['session_id'] !== undefined && record['session_id'] !== sessionId)
            || (record['cli'] != null && typeof record['cli'] !== 'string')
            || (record['tool_log'] != null && typeof record['tool_log'] !== 'string')) throw new Error('invalid_message_snapshot');
        const row = record as unknown as MessageItem;
        const normalized: MessageItem = { ...row, ...(sessionId === null ? {} : { session_id: sessionId }) };
        // Derive only from the actual API row, not a supplied helper field or IDB id.
        delete normalized.server_message_id;
        if (typeof row.id === 'number') normalized.server_message_id = row.id;
        return normalizeMessageToolLog(normalized);
    });
    return { sessionId, messages };
}

function legacyCachePreview(messages: CachedMessage[]): void {
    if (!messages.length) return;
    const box = document.createElement('details'); box.className = 'activity-legacy-cache';
    const title = document.createElement('summary'); title.textContent = 'Unverified legacy cache preview';
    const notice = document.createElement('p');
    notice.textContent = 'This limited cache preview has no verified conversation identity. Connect to refresh; it cannot load Activity history.';
    const text = document.createElement('pre');
    text.textContent = messages.slice(-40).map(message => message.content.slice(0, 1000)).join('\n\n');
    box.append(title, notice, text); chatContainer()?.append(box);
}
const chatContainer = () => document.getElementById('chatMessages');

async function loadMessagesOnce(context: MessageReadContext): Promise<void> {
    const vs = getVirtualScroll();
    const chatEl = document.getElementById('chatMessages');
    const previousScope = getMessageScope();
    const locationKey = readCurrentMessageLocationKey();
    let workingDir = readWorkingDirFromScope(previousScope);
    try {
        const settings = await readMessageSource(() => api<{ workingDir?: string }>('/api/settings', { signal: context.signal }), context.signal);
        if (settings?.workingDir) workingDir = settings.workingDir;
    } catch { /* localStorage fallback already initialized currentScope */ }
    if (!context.current()) return;
    const nextScope = buildMessageScopeIdentity({ locationKey, workingDir });
    setMessageScope(nextScope);
    const scopeChanged = nextScope !== previousScope;
    let snapshot: ReturnType<typeof parseMessageSnapshot> | null = null;
    try {
        const raw = await readMessageSource(() => api<unknown>(context.path, { signal: context.signal }), context.signal);
        if (raw !== null) snapshot = parseMessageSnapshot(raw, context.requestedSession);
    } catch (error) { if (context.current()) console.warn('[history] message snapshot unavailable', error); }
    if (!context.current()) return;
    if (snapshot) {
        const safeMsgs = snapshot.messages;
        seedCompletedElicitationsFromMessages(safeMsgs);
        const hadRenderedHistory = Boolean(chatEl?.querySelector('.msg')) || vs.active;
        const signature = historySignature(`${nextScope}:${snapshot.sessionId ?? ''}`, safeMsgs);
        renderedView = context.key; renderedSession = snapshot.sessionId;
        renderedRuns = new Set(safeMsgs.filter(message => message.role === 'assistant' && message.trace_run_id).map(message => message.trace_run_id!));
        if (hadRenderedHistory && !scopeChanged && signature === lastRenderedSignature) {
            updateStatMsgs(safeMsgs.length);
            setActivityTranscript(renderedSession, renderedRuns);
            return; // identical history — keep the live DOM and scroll state
        }
        lastRenderedSignature = signature;
        const shouldForceBottom = scopeChanged || !hadRenderedHistory;
        const savedIndex = !shouldForceBottom && vs.active ? vs.firstVisibleIndex() : null;
        if (chatEl) recycleActivityHistory(chatEl);
        vs.clear();
        if (chatEl) chatEl.innerHTML = '';
        if (safeMsgs.length >= VS_THRESHOLD) {
            bootstrapVirtualHistory(buildVirtualHistoryItems(safeMsgs), makeBootstrapDeps(vs, {
                forceInitialBottom: shouldForceBottom,
                restoreIndex: shouldForceBottom ? null : savedIndex,
            }));
        } else {
            hydrateSmallHistory(safeMsgs);
            if (shouldForceBottom) settleChatBottomAfterInitialLoad();
        }
        cacheMessages(safeMsgs.map(m => ({
            ...(m.id !== undefined ? { message_id: m.id } : {}),
            role: m.role, content: m.content, cli: m.cli ?? null, tool_log: m.tool_log ?? null, timestamp: Date.now(),
            trace_run_id: m.trace_run_id ?? null, ...(m.session_id === undefined ? {} : { session_id: m.session_id }),
        })), nextScope).catch(() => {});
        setActivityTranscript(renderedSession, renderedRuns);
        updateStatMsgs(safeMsgs.length);
        showEmptyState();
        return;
    }
    if (chatEl && chatEl.children.length > 0 && renderedView === context.key) {
        setActivityTranscript(renderedSession, renderedRuns);
        showEmptyState();
        return;
    }
    if (chatEl && renderedView !== context.key) { recycleActivityHistory(chatEl); vs.clear(); chatEl.replaceChildren(); }
    const allCached = await readMessageSource(() => getScopedMessages(nextScope), context.signal);
    if (!context.current()) return;
    const cached = (context.requestedSession === null ? allCached
        : allCached.filter(message => message.session_id === context.requestedSession)).slice(-BOOT_MESSAGE_WINDOW);
    if (cached.length > 0) {
        const safeCached = cached.map(cachedToMessage).map(normalizeMessageToolLog);
        seedCompletedElicitationsFromMessages(safeCached);
        if (safeCached.length >= VS_THRESHOLD) {
            bootstrapVirtualHistory(buildVirtualHistoryItems(safeCached), makeBootstrapDeps(vs, {
                forceInitialBottom: true,
            }));
        } else {
            hydrateSmallHistory(safeCached);
            settleChatBottomAfterInitialLoad();
        }
        addSystemMsg(`${ICONS.warning} ${t('ui.offline.banner')}`);
        updateStatMsgs(safeCached.length);
    }
    if (context.requestedSession !== null) legacyCachePreview(allCached.filter(message => message.session_id === undefined));
    renderedView = context.key; renderedSession = context.requestedSession;
    renderedRuns = new Set(cached.filter(message => message.role === 'assistant' && message.trace_run_id).map(message => message.trace_run_id!));
    setActivityTranscript(renderedSession, renderedRuns);
    showEmptyState();
}
