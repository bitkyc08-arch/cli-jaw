export {
    launchChrome, connectCdp, getActivePage, getActivePort,
    listTabs, getBrowserStatus, closeBrowser,
    getBrowserRuntimeStatus, beginBrowserActivity, withBrowserActivity,
    resetBrowserRuntimeForTests,
    getCdpSession, getActiveTab, switchTab,
    createTab, closeTab, getPageByTargetId, waitForPageByTargetId,
    markBrowserStateChanged, getBrowserStateVersion,
    markTabActive, forgetTabActivity, getTabActivity,
} from './connection.js';
export type { BrowserTabInfo, ActiveTabResult } from './connection.js';
export type { BrowserRuntimeOwner, BrowserRuntimeStatus } from './runtime-owner.js';
export { getBrowserDiagnostics } from './runtime-diagnostics.js';
export type { BrowserRuntimeDiagnostics, BrowserRuntimeIssue } from './runtime-diagnostics.js';
export { cleanupBrowserRuntimeOrphans, inspectBrowserRuntimeOrphans } from './runtime-orphans.js';
export type { BrowserRuntimeCleanupResult, BrowserRuntimeOrphanCandidate } from './runtime-orphans.js';
export {
    cleanupIdleTabs, isPinned, parseTabDuration, pinTab, selectTabsForCleanup, unpinTab,
} from './tab-lifecycle.js';
export type { TabCleanupCandidate, TabCleanupOptions, TabCleanupSummary } from './tab-lifecycle.js';
export * from './primitives.js';

export {
    snapshot, screenshot, click, type, press,
    hover, navigate, evaluate, getPageText,
    mouseClick, getDom, waitForSelector, waitForText,
    reload, resize, scroll, select, drag,
    mouseMove, mouseDown, mouseUp, getConsole, getNetwork,
} from './actions.js';

export { visionClick, extractCoordinates } from './vision.js';
export { sanitizeTarget, appendBounded, MAX_TARGET_LENGTH, MAX_CODEX_STDOUT_BYTES } from './vision-input.js';
export * as adaptiveFetch from './adaptive-fetch/index.js';
export * as webAi from './web-ai/index.js';
export type * from './web-ai/index.js';
