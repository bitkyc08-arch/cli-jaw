import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wsPathTs = join(__dirname, '../../public/js/ws.ts');
const wsPathJs = join(__dirname, '../../public/js/ws.js');
const uiPathTs = join(__dirname, '../../public/js/ui.ts');
const uiPathJs = join(__dirname, '../../public/js/ui.js');
const virtualScrollPathTs = join(__dirname, '../../public/js/virtual-scroll.ts');
const virtualScrollPathJs = join(__dirname, '../../public/js/virtual-scroll.js');
const wsPath = existsSync(wsPathTs) ? wsPathTs : wsPathJs;
const uiPath = existsSync(uiPathTs) ? uiPathTs : uiPathJs;
const virtualScrollPath = existsSync(virtualScrollPathTs) ? virtualScrollPathTs : virtualScrollPathJs;
const hasWs = existsSync(wsPath);
const hasUi = existsSync(uiPath);
const hasVirtualScroll = existsSync(virtualScrollPath);

test('WRS-001: reconnect snapshot owns status instead of forced idle reset', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes("syncOrchestrateSnapshot('reconnect', { hydrateRun: true })"), 'ws reconnect should hydrate runtime snapshot');
    assert.ok(!wsSrc.includes("m.setStatus('idle');"), 'ws reconnect should not force idle before snapshot');
});

test('WRS-002: queue updates rehydrate queued overlay from snapshot', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    const queueBlock = wsSrc.slice(wsSrc.indexOf("msg.type === 'queue_update'"), wsSrc.indexOf("msg.type === 'worklog_created'"));
    assert.ok(queueBlock.includes("syncOrchestrateSnapshot('queue_update').catch"), 'queue updates should refresh snapshot state');
    assert.ok(queueBlock.includes('updateQueueBadge(msg.pending || 0)'), 'queue updates should still refresh badge count');
});

test('WRS-002b: browser restore hooks resync authoritative orchestration snapshot', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('function registerOrchestrateRestoreHooks'), 'ws should register orchestration restore hooks');
    assert.ok(wsSrc.includes('function syncAfterBrowserRestore(reason: string)'), 'browser restore hooks should route through one wrapper');
    assert.ok(wsSrc.includes('let snapshotSyncInFlight: Promise<void> | null = null'), 'snapshot sync should dedupe in-flight requests');
    assert.ok(wsSrc.includes('let lastSnapshotSyncAt = 0'), 'snapshot sync should track last sync timestamp');
    assert.ok(wsSrc.includes('const SNAPSHOT_SYNC_THROTTLE_MS = 750'), 'restore snapshot sync should have an explicit throttle window');
    assert.ok(wsSrc.includes('if (snapshotSyncInFlight) return snapshotSyncInFlight'), 'restore sync should reuse in-flight snapshot request');
    assert.ok(wsSrc.includes('now - lastSnapshotSyncAt < SNAPSHOT_SYNC_THROTTLE_MS'), 'restore sync should throttle rapid duplicate calls');
    assert.ok(wsSrc.includes('if (!options.hydrateRun)'), 'normal restore sync should be throttled separately from reconnect hydration');
    assert.ok(wsSrc.includes("window.addEventListener('focus'"), 'focus should trigger orchestrate snapshot sync');
    assert.ok(wsSrc.includes("window.addEventListener('pageshow'"), 'pageshow should trigger orchestrate snapshot sync');
    assert.ok(wsSrc.includes("document.addEventListener('visibilitychange'"), 'visibilitychange should trigger orchestrate snapshot sync');
    assert.ok(wsSrc.includes("document.addEventListener('resume'"), 'resume should trigger browser restore sync');
    assert.ok(wsSrc.includes('wasDiscarded'), 'initial Chrome discard restore should be handled');
    assert.ok(wsSrc.includes("requestBrowserRestoreSync('focus')"), 'focus hook should call the debounced restore wrapper');
    assert.ok(wsSrc.includes("requestBrowserRestoreSync('pageshow')"), 'pageshow hook should call the debounced restore wrapper');
    assert.ok(wsSrc.includes("requestBrowserRestoreSync('visibilitychange')"), 'visibility hook should call the debounced restore wrapper');
    assert.ok(wsSrc.includes("requestBrowserRestoreSync('resume')"), 'resume hook should call the debounced restore wrapper');
    assert.ok(wsSrc.includes("requestBrowserRestoreSync('discard')"), 'discard path should call the restore wrapper');
    assert.ok(wsSrc.includes('showChatRestoreIndicator(reason)'), 'wrapper should show the restore indicator before sync');
    assert.ok(wsSrc.includes('syncOrchestrateSnapshot(reason, { hydrateRun: true })'), 'wrapper should still refresh and hydrate the authoritative snapshot');
    assert.ok(wsSrc.includes('reconcileChatBottomAfterRestore(reason)'), 'wrapper should reconcile bottom after snapshot settles');
});

test('WRS-002c: all slash commands resync snapshot after command response', () => {
    const chatPath = existsSync(join(__dirname, '../../public/js/features/chat.ts'))
        ? join(__dirname, '../../public/js/features/chat.ts')
        : join(__dirname, '../../public/js/features/chat.js');
    const chatSrc = readFileSync(chatPath, 'utf8');
    assert.ok(chatSrc.includes("import { syncOrchestrateSnapshot } from '../ws.js'"), 'chat should import orchestrate snapshot sync');
    assert.ok(chatSrc.includes('finally'), 'command path should sync after success and failure');
    assert.ok(chatSrc.includes("syncOrchestrateSnapshot('command')"), 'all commands should trigger snapshot sync');
});

test('WRS-003: hydrateActiveRun keeps live process block collapsed by default', { skip: !hasUi && 'public/js/ui source not found' }, () => {
    const uiSrc = readFileSync(uiPath, 'utf8');
    const start = uiSrc.indexOf('export function hydrateActiveRun');
    const end = uiSrc.indexOf('export function appendAgentText');
    const hydrateBlock = uiSrc.slice(start, end);
    assert.ok(hydrateBlock.includes('hydrateStreamRenderer'), 'hydrateActiveRun should seed stream renderer state');
    assert.ok(hydrateBlock.includes('createProcessBlock(body)'), 'hydrateActiveRun should use the shared process block constructor');
    assert.ok(!hydrateBlock.includes('blockShell'), 'hydrateActiveRun should not bypass the shared constructor');
    assert.ok(!uiSrc.includes('keeps live process block expanded'), 'old expanded-by-default contract should be removed');
});

test('WRS-003b: hydrateActiveRun reuses one live active-run bubble across snapshots', { skip: !hasUi && 'public/js/ui source not found' }, () => {
    const uiSrc = readFileSync(uiPath, 'utf8');
    const hydrateStart = uiSrc.indexOf('export function hydrateActiveRun');
    const hydrateEnd = uiSrc.indexOf('export function appendAgentText');
    const hydrateBlock = uiSrc.slice(hydrateStart, hydrateEnd);
    const helperStart = uiSrc.indexOf('function ensureActiveRunMessage');
    const helperEnd = uiSrc.indexOf('export function hydrateActiveRun');
    const helperBlock = uiSrc.slice(helperStart, helperEnd);
    const activeHelperStart = uiSrc.indexOf('function currentAgentDivForActiveRun');
    const activeHelperEnd = uiSrc.indexOf('export function showLiveToolActivity');
    const activeHelperBlock = uiSrc.slice(activeHelperStart, activeHelperEnd);

    assert.ok(uiSrc.includes("const ACTIVE_RUN_HYDRATED_ATTR = 'data-active-run-hydrated'"), 'hydrated active-run DOM must be explicitly marked');
    assert.ok(uiSrc.includes('function removeStaleHydratedActiveRuns'), 'stale hydrated active-run bubbles must be removable');
    assert.ok(uiSrc.includes('function ensureActiveRunMessage'), 'hydrate should use a shared active-run message helper');
    assert.ok(uiSrc.includes('function currentAgentDivForActiveRun'), 'hydrate should use a shared current-run ownership helper');
    assert.ok(activeHelperBlock.includes('state.currentAgentDiv && state.currentAgentDiv.isConnected'), 'helper should prefer the connected live agent bubble');
    assert.ok(activeHelperBlock.includes('hasFollowingUserMessage(existing)'), 'helper should reject stale agent bubbles once a later user turn exists');
    assert.ok(helperBlock.includes("addMessage('agent', '', cli || null)"), 'helper should add only when no live bubble exists');
    assert.ok(helperBlock.includes('removeStaleHydratedActiveRuns(existing)'), 'helper should remove old hydrated bubbles while preserving the live one');
    assert.ok(hydrateBlock.includes('removeStaleHydratedActiveRuns();'), 'non-running snapshots should clean stale hydrated bubbles');
    assert.ok(hydrateBlock.includes('state.currentAgentDiv = ensureActiveRunMessage(snapshot.cli || null)'), 'hydrateActiveRun must not call addMessage directly');
    assert.ok(!hydrateBlock.includes("state.currentAgentDiv = addMessage('agent'"), 'hydrateActiveRun should not append a new bubble on every snapshot');
    assert.ok(uiSrc.includes('state.currentAgentDiv.removeAttribute(ACTIVE_RUN_HYDRATED_ATTR)'), 'finalized active-run bubbles should become normal chat messages');
});

test('WRS-004: applyQueuedOverlay no longer renders chat bubbles for queued items (pending-queue panel owns them)', { skip: !hasUi && 'public/js/ui source not found' }, () => {
    const uiSrc = readFileSync(uiPath, 'utf8');
    // New policy (Fix B4): queued items live exclusively in the pending-queue panel.
    // Chat bubble appears only when backend broadcasts new_message with fromQueue=true
    // (= the item actually started running). applyQueuedOverlay only cleans up legacy
    // overlay nodes from older builds during a soft reload.
    const fnIdx = uiSrc.indexOf('export function applyQueuedOverlay');
    assert.ok(fnIdx > 0, 'applyQueuedOverlay must still exist for legacy overlay cleanup');
    // Cap the inspected block at the next export so the next function's body doesn't leak in.
    const tail = uiSrc.slice(fnIdx);
    const nextExportRel = tail.slice(40).search(/\nexport (function|const|let|class)/);
    const fnBlock = nextExportRel > 0 ? tail.slice(0, nextExportRel + 40) : tail.slice(0, 1000);
    assert.ok(!fnBlock.includes('addMessage('), 'applyQueuedOverlay must NOT call addMessage — queued items live only in pending-queue panel');
    assert.ok(fnBlock.includes('data-queued-overlay="true"'), 'must still clean up legacy overlay nodes from older builds');
});

test('WRS-005: virtual scroll restore hooks use guarded bottom reconciliation after browser restore', { skip: !hasVirtualScroll && 'public/js/virtual-scroll source not found' }, () => {
    const src = readFileSync(virtualScrollPath, 'utf8');
    assert.ok(src.includes('isNearBottom('), 'VirtualScroll should expose near-bottom intent detection');
    assert.ok(src.includes('reconcileBottomAfterLayout('), 'VirtualScroll should expose post-layout bottom reconciliation');
    assert.ok(src.includes('forceBottomAfterRestore('), 'VirtualScroll should expose forced restore bottom reconciliation');
    assert.ok(src.includes('reconcileAfterRestore('), 'VirtualScroll should expose guarded restore reconciliation');
    assert.ok(src.includes('setRestoreFollowPredicate('), 'VirtualScroll should accept a live follow predicate');
    assert.ok(src.includes('this.reconcileAfterRestore(reason, this.shouldFollowAfterRestore)'), 'restore hooks should use guarded reconciliation');
    assert.ok(src.includes("window.addEventListener('pageshow'"), 'bfcache restore should be handled');
    assert.ok(src.includes("document.addEventListener('visibilitychange'"), 'sleep/wake visible restore should be handled');
    assert.ok(src.includes("window.addEventListener('focus'"), 'Chrome reopen/focus restore should be handled');
    assert.ok(src.includes("document.addEventListener('resume'"), 'Chrome resume restore should be handled');
    assert.ok(src.includes('wasDiscarded'), 'Chrome tab discard restore should be detected');
});

test('WRS-006: reconnect snapshot reapplies bottom anchor without stale near-bottom gate', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    // Phase 3: hydration lives in handleChannelUp,
    // shared by the SSE channel and the legacy WS fallback.
    const wsSrc = readFileSync(wsPath, 'utf8');
    const openIdx = wsSrc.indexOf('function handleChannelUp');
    assert.ok(openIdx > 0, 'channel up handler should exist');
    const openBlock = wsSrc.slice(openIdx, wsSrc.indexOf('function handleChannelDown', openIdx));
    assert.ok(!openBlock.includes('const shouldFollowBottom = isChatNearBottom()'), 'reconnect should not capture stale near-bottom geometry before hydration');
    assert.ok(!openBlock.includes('reconcileChatBottomAfterLayout(shouldFollowBottom)'), 'reconnect should not gate restore on stale geometry');
    assert.ok(openBlock.includes("reconcileChatBottomAfterRestore('reconnect')"), 'reconnect should run guarded restore bottom reconciliation after hydration');
});

test('WRS-007: ui exposes guarded restore helper used by restore and reconnect paths', { skip: !hasUi && 'public/js/ui source not found', timeout: 5000 }, async t => {
    const uiSrc = readFileSync(uiPath, 'utf8');
    const scrollSrc = readFileSync(join(__dirname, '../../public/js/features/chat-scroll.ts'), 'utf8');
    const historySrc = readFileSync(join(__dirname, '../../public/js/features/message-history.ts'), 'utf8');
    assert.ok(uiSrc.includes('isChatNearBottom'), 'ui should export bottom intent reader');
    assert.ok(uiSrc.includes('reconcileChatBottomAfterLayout'), 'ui should export reconnect reconciliation helper');
    assert.ok(uiSrc.includes('reconcileChatBottomAfterRestore'), 'ui should export guarded restore reconciliation helper');
    assert.ok(uiSrc.includes('showChatRestoreIndicator'), 'ui should export restore indicator show helper');
    assert.ok(uiSrc.includes('hideChatRestoreIndicatorAfterSettle'), 'ui should export settle-aware hide helper');
    assert.ok(scrollSrc.includes('showChatRestoreIndicator(reason)'), 'restore reconciliation should own indicator lifecycle');
    assert.ok(scrollSrc.includes('hideChatRestoreIndicatorAfterSettle()'), 'restore reconciliation should hide indicator after settle');
    assert.ok(scrollSrc.includes("vs.reconcileBottomAfterLayout('reconnect', true)"), 'virtual-scroll reconnect should use the same reconciliation path');
    assert.ok(scrollSrc.includes('vs.reconcileAfterRestore'), 'restore helper should delegate to virtual scroll guarded restore');
    assert.ok(scrollSrc.includes("type ScrollIntent = 'unknown' | 'following' | 'pinnedAway'"), 'scroll module should track explicit bottom-follow intent');
    assert.ok(scrollSrc.includes('const scrollIfFollowing = () =>'), 'non-VS restore should use a guarded final DOM scroll closure');
    assert.ok(scrollSrc.includes('requestChatRestoreFrame(scrollIfFollowing)'), 'non-VS restore final RAF should re-check live intent');
    assert.ok(scrollSrc.includes('export function settleChatBottomAfterInitialLoad()'), 'initial load should expose a settle helper for late layout growth');
    assert.ok(scrollSrc.includes("vs.reconcileAfterRestore('manual', canFollowAfterRestore)"), 'initial virtual-scroll settle should remain cancelable when the user scrolls away');
    assert.ok(historySrc.includes('forceInitialBottom?: boolean'), 'bootstrap deps should expose an explicit initial-load bottom option');
    assert.ok(historySrc.includes('? () => true'), 'initial history bootstrap should force bottom even if restored browser scroll looks pinned away');
    assert.ok(historySrc.includes(': canFollowAfterRestore'), 'non-initial virtual-history bootstrap should not force bottom when user is pinned away');
    assert.ok(historySrc.includes('getMessageScope'), 'loadMessages should compare previous message scope before deciding restore behavior');
    assert.ok(historySrc.includes('export function buildMessageLocationKey'), 'message scope should include a reusable location key helper');
    assert.ok(historySrc.includes('export function buildMessageScopeIdentity'), 'message scope should include a reusable identity helper');
    assert.ok(historySrc.includes('window.location.pathname'), 'legacy manager preview path must distinguish same-origin instance switches');
    // Location/settings failure ordering is executed below through loadMessages,
    // not inferred from the old direct-api assignment spelling.
    assert.ok(historySrc.includes('const scopeChanged = nextScope !== previousScope'), 'loadMessages should explicitly detect message source changes');
    assert.ok(historySrc.includes('const shouldForceBottom = scopeChanged || !hadRenderedHistory'), 'scope changes should force bottom even when old DOM exists');
    assert.ok(historySrc.includes('const hadRenderedHistory = Boolean(chatEl?.querySelector(\'.msg\')) || vs.active'), 'loadMessages should distinguish initial load from reconnect refresh');
    assert.ok(historySrc.includes('forceInitialBottom: shouldForceBottom'), 'fresh or changed-scope server history load should bottom, while same-scope reconnect preserves pinned-away readers');
    assert.ok(historySrc.includes('restoreIndex: shouldForceBottom ? null : savedIndex'), 'changed scopes must not reuse stale virtual-scroll restore indices');
    assert.ok(historySrc.includes('forceInitialBottom: true'), 'offline cache initial load should also bottom');
    assert.ok(historySrc.includes('settleChatBottomAfterInitialLoad();'), 'successful initial load paths should settle again after lazy render/layout growth');
    assert.ok(historySrc.includes('if (shouldForceBottom) settleChatBottomAfterInitialLoad();'), 'small fresh or changed-scope history should also settle to bottom without yanking same-scope reconnect readers');
    assert.ok(!scrollSrc.includes('userNearBottom = true;\\n    const vs = getVirtualScroll();\\n    if (vs.active)'), 'restore helper should not reset near-bottom intent before guarded restore');

    const names = ['window', 'document', 'HTMLElement', 'HTMLAnchorElement', 'Element', 'Node',
        'NodeFilter', 'navigator', 'localStorage', 'MutationObserver', 'getComputedStyle',
        'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver',
        'atob', 'btoa', 'indexedDB'] as const;
    const globals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const unexpected: string[] = [], ledger: string[] = [], warnings: string[] = [];
    let rejectSettings!: (error: Error) => void;
    const settings = new Promise<Response>((_resolve, reject) => { rejectSettings = reject; });
    let settingsEntered!: () => void;
    const entered = new Promise<void>(resolve => { settingsEntered = resolve; });
    let loading: Promise<void> | undefined;
    let rendering: typeof import('../../public/js/render.ts') | undefined;
    let vs: ReturnType<typeof import('../../public/js/virtual-scroll.ts')['getVirtualScroll']> | undefined;
    try {
        setupWebUiDom();
        window.history.replaceState(null, '', '/i/24577/');
        // Observe actual location reads without replacing the location value.
        const realWindow = window;
        Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: new Proxy(realWindow, {
            get(target, key) {
                if (key === 'location') ledger.push('location');
                return Reflect.get(target, key, target);
            },
        }) });
        t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : String(input), 'http://127.0.0.1');
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
            if (method === 'GET' && url.origin === 'http://127.0.0.1') {
                if (url.pathname === '/i/24577/api/auth/token' && !url.search)
                    return Response.json({ token: 'wp37-location' });
                if (url.pathname === '/i/24577/api/settings' && !url.search) {
                    ledger.push('settings:start'); settingsEntered();
                    return settings;
                }
                if (url.pathname === '/i/24577/api/messages' && url.search === '?limit=3000&withSession=1') {
                    ledger.push('messages');
                    return Response.json({ ok: true, data: { sessionId: 'location-chat', messages: [] } });
                }
            }
            unexpected.push(`${method} ${url.href}`);
            throw new Error(`Unexpected fixture HTTP: ${method} ${url.href}`);
        });
        const cache = await import('../../public/js/features/idb-cache.ts');
        t.mock.module('../../public/js/features/idb-cache.js', { namedExports: {
            ...cache,
            getMessageScope() { ledger.push('scope:read'); return cache.getMessageScope(); },
        } });
        const history = await import('../../public/js/features/message-history.ts');
        rendering = await import('../../public/js/render.ts');
        vs = (await import('../../public/js/virtual-scroll.ts')).getVirtualScroll();
        await (await import('../../public/js/api.ts')).getAuthToken();
        const oldScope = 'http://127.0.0.1/i/24576/::/work/original';
        cache.setMessageScope(oldScope); ledger.length = 0;
        loading = history.loadMessages();
        await entered;
        assert.equal(history.historyReloadInFlight(), true);
        assert.equal(cache.getMessageScope(), oldScope, 'pending settings must not prematurely publish a new scope');
        const scopeRead = ledger.indexOf('scope:read');
        const capturedLocation = ledger.indexOf('location', scopeRead + 1);
        assert.ok(scopeRead >= 0 && capturedLocation > scopeRead && capturedLocation < ledger.indexOf('settings:start'),
            'the loader must capture location after reading the previous scope and before starting settings, not only read its outer admission key');
        assert.equal(ledger.includes('messages'), false, 'message read must wait for settings settlement');
        ledger.push('settings:reject'); rejectSettings(new Error('wp37 settings offline'));
        await loading;
        assert.equal(history.historyReloadInFlight(), false);
        assert.equal(cache.getMessageScope(), 'http://127.0.0.1/i/24577/::/work/original',
            'failed settings retain the working directory but use the new location, never the old instance scope');
        assert.ok(ledger.indexOf('messages') > ledger.indexOf('settings:reject'));
        assert.ok(warnings.some(warning => warning === '[api] /api/settings failed: wp37 settings offline'),
            'the real asynchronous API failure path must execute');
        assert.deepEqual(unexpected, [], 'unknown HTTP cannot be swallowed into a successful recovery');
    } finally {
        try {
            rejectSettings(new Error('fixture cleanup'));
            await loading;
        } finally {
            rendering?.cancelPostRender(); vs?.clear(); resetWebUiDom();
            t.mock.restoreAll();
            for (const [name, descriptor] of globals) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        }
    }
});

test('WRS-008: channel-down toast waits out micro-drops (grace period)', () => {
    const wsSrc = readFileSync(wsPathTs, 'utf8');
    const downIdx = wsSrc.indexOf('function handleChannelDown');
    assert.ok(downIdx >= 0, 'handleChannelDown should exist');
    const block = wsSrc.slice(downIdx, downIdx + 900);
    assert.ok(block.includes('CHANNEL_DOWN_TOAST_GRACE_MS'),
        'disconnect toast must be deferred — SSE micro-drops reconnect in ~2s with replay');
    const upIdx = wsSrc.indexOf('function handleChannelUp');
    const upBlock = wsSrc.slice(upIdx, upIdx + 600);
    assert.ok(upBlock.includes('clearChannelDownToastTimer()'),
        'reconnect within grace must cancel the pending toast');
});

test('WRS-009: replay gap hydrates messages and runtime snapshot', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    const branchIdx = wsSrc.indexOf("msg.type === 'replay_gap'");
    const handlerIdx = wsSrc.indexOf('function handleReplayGap');
    assert.ok(branchIdx > 0, 'ws dispatcher should handle replay_gap events');
    assert.ok(handlerIdx > 0, 'ws should centralize replay gap recovery');
    const handlerBlock = wsSrc.slice(handlerIdx, wsSrc.indexOf('function handleChannelDown', handlerIdx));
    assert.ok(handlerBlock.includes('showChatRestoreIndicator'), 'replay gap should show restore feedback');
    assert.ok(handlerBlock.includes('m.loadMessages()'), 'replay gap should reload chat history');
    assert.ok(handlerBlock.includes('lastLoadTs = Date.now()'), 'replay gap should update the reload throttle timestamp');
    assert.ok(handlerBlock.includes("syncOrchestrateSnapshot('replay_gap', { hydrateRun: true })"), 'replay gap should hydrate runtime snapshot');
    assert.ok(handlerBlock.includes("reconcileChatBottomAfterRestore('replay_gap')"), 'replay gap should restore the bottom anchor after hydration');
});

test('WRS-010: browser/preview restore reloads messages before snapshot hydration', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    const wsSrc = readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('function shouldReloadMessagesForRestore'),
        'restore path should classify which browser/preview restores require message history');
    const classifierStart = wsSrc.indexOf('function shouldReloadMessagesForRestore');
    const classifierBlock = wsSrc.slice(classifierStart, wsSrc.indexOf('function syncAfterBrowserRestore', classifierStart));
    for (const reason of ['iframe-visible', 'pageshow', 'discard', 'visibilitychange']) {
        assert.ok(classifierBlock.includes(`'${reason}'`), `${reason} restore must be history-sensitive`);
    }
    assert.ok(!classifierBlock.includes("'focus'"), 'focus restores stay snapshot-only (reload churn)');
    const wrapperStart = wsSrc.indexOf('function syncAfterBrowserRestore');
    const wrapper = wsSrc.slice(wrapperStart, wsSrc.indexOf('function requestBrowserRestoreSync', wrapperStart));
    assert.ok(wrapper.includes('shouldReloadMessagesForRestore(reason)'),
        'restore wrapper must consult the history-sensitivity classifier');
    assert.ok(wrapper.includes('m.loadMessages()'),
        'history-sensitive restore paths must reload durable chat history');
    assert.ok(wrapper.indexOf('m.loadMessages()') < wrapper.indexOf("syncOrchestrateSnapshot(reason, { hydrateRun: true })"),
        'durable history must load before transient snapshot hydration');
    assert.ok(wrapper.includes('lastLoadTs = Date.now()'),
        'restore history load should update the reconnect reload throttle');
});

test('WRS-011: concurrent restore and channel-up share one history load', { skip: !hasWs && 'public/js/ws source not found' }, () => {
    // preview instance-switch remounts boot the iframe while
    // the onLoad visibility ping fires — without a single-flight guard the two
    // loadMessages() calls race and can double-bootstrap the virtual scroll,
    // leaving the newest rows lazy-pending (invisible until a click/restore).
    const historyPath = join(__dirname, '../../public/js/features/message-history.ts');
    const historySrc = readFileSync(historyPath, 'utf8');
    assert.ok(historySrc.includes('let loadMessagesInFlight'),
        'message history must track the in-flight load promise');
    assert.ok(historySrc.includes('if (loadMessagesInFlight) return loadMessagesInFlight;'),
        'concurrent loadMessages callers must join the in-flight load instead of racing');
    assert.ok(historySrc.includes('loadMessagesInFlight = null'),
        'the single-flight slot must clear when the load settles');
    const wsSrc = readFileSync(wsPath, 'utf8');
    const wrapperStart = wsSrc.indexOf('function syncAfterBrowserRestore');
    const wrapper = wsSrc.slice(wrapperStart, wsSrc.indexOf('function requestBrowserRestoreSync', wrapperStart));
    assert.ok(wrapper.includes('lastLoadTs > 0'),
        'restore reload must defer to the boot channel-up load for first paint');
});
