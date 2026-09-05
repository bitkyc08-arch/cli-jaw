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
import { withCurrentSessionQuery } from './session-hub.js';
import { remountLiveActivity } from './activity-live.js';

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
    vs.onPostRender = (viewport: HTMLElement) => {
        remountLiveActivity(viewport);
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

// devlog 260609 83: preview instance-switch remounts can fire the boot
// channel-up reload and the onLoad visibility-ping reload concurrently.
// Without single-flight they both clear+bootstrap the virtual scroll and the
// newest rows can stay lazy-pending. Concurrent callers join the same load.
let loadMessagesInFlight: Promise<void> | null = null;

export async function loadMessages(): Promise<void> {
    if (loadMessagesInFlight) return loadMessagesInFlight;
    loadMessagesInFlight = loadMessagesOnce().finally(() => {
        loadMessagesInFlight = null;
    });
    return loadMessagesInFlight;
}

/** True while a history snapshot fetch/rebuild is mid-flight. A live append
 *  during this window races the rebuild — the fetched snapshot may not
 *  contain the row yet, and the rebuild wipes whatever was appended, so the
 *  row is lost or lands out of order. Callers should reload after the
 *  in-flight load settles instead of appending. */
export function historyReloadInFlight(): boolean {
    return loadMessagesInFlight !== null;
}

async function loadMessagesOnce(): Promise<void> {
    const vs = getVirtualScroll();
    const chatEl = document.getElementById('chatMessages');
    const previousScope = getMessageScope();
    const locationKey = readCurrentMessageLocationKey();
    let workingDir = readWorkingDirFromScope(previousScope);
    try {
        const settings = await api<{ workingDir?: string }>('/api/settings');
        if (settings?.workingDir) workingDir = settings.workingDir;
    } catch { /* localStorage fallback already initialized currentScope */ }
    const nextScope = buildMessageScopeIdentity({ locationKey, workingDir });
    setMessageScope(nextScope);
    const scopeChanged = nextScope !== previousScope;
    const msgs = await api<MessageItem[]>(`/api/messages${bootMessageQuery()}`);
    if (msgs !== null) {
        const safeMsgs = msgs.map(normalizeMessageToolLog);
        seedCompletedElicitationsFromMessages(safeMsgs);
        const hadRenderedHistory = Boolean(chatEl?.querySelector('.msg')) || vs.active;
        const signature = historySignature(nextScope, safeMsgs);
        if (hadRenderedHistory && !scopeChanged && signature === lastRenderedSignature) {
            updateStatMsgs(safeMsgs.length);
            return; // identical history — keep the live DOM and scroll state
        }
        lastRenderedSignature = signature;
        const shouldForceBottom = scopeChanged || !hadRenderedHistory;
        const savedIndex = !shouldForceBottom && vs.active ? vs.firstVisibleIndex() : null;
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
        }))).catch(() => {});
        updateStatMsgs(safeMsgs.length);
        showEmptyState();
        return;
    }
    if (chatEl && chatEl.children.length > 0) {
        showEmptyState();
        return;
    }
    const cached = await getScopedMessages();
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
    showEmptyState();
}
