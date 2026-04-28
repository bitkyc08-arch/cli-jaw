export {
    launchChrome, connectCdp, getActivePage, getActivePort,
    listTabs, getBrowserStatus, closeBrowser,
    getCdpSession, getActiveTab, switchTab,
    markBrowserStateChanged, getBrowserStateVersion,
} from './connection.js';
export type { BrowserTabInfo, ActiveTabResult } from './connection.js';

export {
    snapshot, screenshot, click, type, press,
    hover, navigate, evaluate, getPageText,
    mouseClick, getDom, waitForSelector, waitForText,
    reload, resize, scroll, select, drag,
    mouseMove, mouseDown, mouseUp, getConsole, getNetwork,
} from './actions.js';

export { visionClick, extractCoordinates } from './vision.js';
