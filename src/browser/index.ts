export {
    launchChrome, connectCdp, getActivePage, getActivePort,
    listTabs, getBrowserStatus, closeBrowser,
    getBrowserRuntimeStatus, beginBrowserActivity, withBrowserActivity,
    resetBrowserRuntimeForTests,
    getCdpSession, getActiveTab, switchTab,
    createTab, closeTab, getPageByTargetId, waitForPageByTargetId,
    markBrowserStateChanged, getBrowserStateVersion,
} from './connection.js';
export type { BrowserTabInfo, ActiveTabResult } from './connection.js';
export type { BrowserRuntimeOwner, BrowserRuntimeStatus } from './runtime-owner.js';
export * from './primitives.js';

export {
    snapshot, screenshot, click, type, press,
    hover, navigate, evaluate, getPageText,
    mouseClick, getDom, waitForSelector, waitForText,
    reload, resize, scroll, select, drag,
    mouseMove, mouseDown, mouseUp, getConsole, getNetwork,
} from './actions.js';

export { visionClick, extractCoordinates } from './vision.js';
export * as webAi from './web-ai/index.js';
export type * from './web-ai/index.js';
