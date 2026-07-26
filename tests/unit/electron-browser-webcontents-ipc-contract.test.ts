/**
 * 030 v1/v4/v5 -- Embedded browser webview IPC contract (Electron main side).
 *
 * Locks in:
 * - the main IPC module validates guests: owned set + getType() === 'webview'
 * - DevTools opens from the main side and falls back to detached for webview guests
 * - screenshot uses capturePage; legacy point-inspect uses inspectElement
 * - CDP-native inspect/snapshot/actions never use page-side script evaluation
 * - action dispatch is allowed for agent-visible tabs; URL/payload gates remain
 * - main index wires registerBrowserIpc and marks owned webview guests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const ipcSource = readFileSync(join(root, 'electron/src/main/lib/browser/ipc.ts'), 'utf-8');
const cdpSource = readFileSync(join(root, 'electron/src/main/lib/browser/cdp.ts'), 'utf-8');
const mainSource = readFileSync(join(root, 'electron/src/main/index.ts'), 'utf-8');

test('guest resolution requires ownership and webview type', () => {
    assert.ok(ipcSource.includes('ownedWebContentsIds.has('), 'only main-observed guests are accepted');
    assert.match(ipcSource, /getType\(\) !== 'webview'/, 'target type must be webview');
    assert.ok(ipcSource.includes('isDestroyed()'), 'destroyed contents are rejected');
});

test('sender origin is validated on every handler', () => {
    const handlerCount = (ipcSource.match(/ipcMain\.handle\(/g) ?? []).length;
    const guardCount = (ipcSource.match(/if \(!isManagerSender\(event\)\)/g) ?? []).length;
    assert.ok(handlerCount >= 5, 'expected browser:* handlers present');
    assert.equal(guardCount, handlerCount, 'every handler checks the Manager sender guard');
    // wp7b moved the origin check into the shared ipc-origin-guard, which
    // isManagerSender delegates to. The file imports the shared guard.
    assert.ok(ipcSource.includes('isManagerSenderGuard') || ipcSource.includes('isAllowedSender'),
        'the Manager sender guard must validate origin');
});

test('DevTools attempts docked open and falls back to detached', () => {
    assert.ok(ipcSource.includes('ensureDevToolsOpen'), 'DevTools open must verify the actual opened state');
    assert.ok(ipcSource.includes('contents.isDevToolsOpened()'), 'DevTools open must inspect the actual state');
    assert.ok(ipcSource.includes("mode: 'detach', activate: true"), 'webview guests need a detached fallback');
    assert.ok(ipcSource.includes('DevTools did not open for the embedded browser'), 'failure must be surfaced to the renderer');
});

test('screenshot uses capturePage and inspect uses inspectElement', () => {
    assert.ok(ipcSource.includes('capturePage()'), 'native capture');
    assert.ok(ipcSource.includes('inspectElement('), 'native inspect');
});

test('CDP adapter uses native Overlay, DOM/AX, and Input domains', () => {
    assert.ok(cdpSource.includes('Overlay.setInspectMode'), 'native inspect must use Chromium Overlay highlight boxes');
    assert.ok(cdpSource.includes('Overlay.inspectNodeRequested'), 'inspect pick must resolve native selected node');
    assert.ok(cdpSource.includes("DOM.describeNode', { backendNodeId"), 'inspect pick must resolve directly from the selected backendNodeId');
    assert.ok(cdpSource.includes("DOM.getBoxModel', { backendNodeId"), 'inspect pick bounds must resolve directly from the selected backendNodeId');
    assert.ok(cdpSource.includes('DOM.getDocument'), 'snapshot must touch the DOM domain');
    assert.ok(cdpSource.includes('DOM.pushNodesByBackendIdsToFrontend'), 'AX backend ids must resolve to DOM nodes for selector/bounds');
    assert.ok(cdpSource.includes('backendDOMNodeId'), 'snapshot should use AX backend DOM ids when direct node ids are absent');
    assert.ok(cdpSource.includes('Accessibility.getFullAXTree'), 'snapshot must include bounded AX data');
    assert.ok(cdpSource.includes('Input.dispatchMouseEvent'), 'click/scroll use CDP Input');
    assert.ok(cdpSource.includes('Input.insertText'), 'typing uses CDP Input.insertText');
    assert.ok(cdpSource.includes('Page.getLayoutMetrics'), 'act coordinates must be checked against the visible viewport');
});

test('act IPC defaults to full actions and gates act by visibility, URL policy, and strict payload parsing', () => {
    assert.ok(ipcSource.includes("case 'setActionsEnabled'"), 'legacy action toggle remains as a compatibility no-op');
    assert.ok(ipcSource.includes('sharedWithAgent: prior?.sharedWithAgent ?? true'), 'new browser tabs are shared with the agent by default');
    assert.ok(ipcSource.includes('actionsEnabled: true'), 'new browser tabs have actions enabled by default');
    assert.ok(ipcSource.includes('entry.sharedWithAgent = true'), 'legacy action toggle keeps the target visible');
    assert.equal(ipcSource.includes('share this browser target before enabling actions'), false, 'actions should not require a separate share prerequisite');
    assert.ok(ipcSource.includes('if (!entry.sharedWithAgent)'), 'act requires the tab to remain shared');
    assert.equal(ipcSource.includes('if (!entry.actionsEnabled)'), false, 'act must not require an explicit action opt-in');
    assert.equal(ipcSource.includes('actions not enabled for this tab'), false, 'no action-disabled error remains');
    assert.ok(ipcSource.includes('current page is not an allowed action target'), 'act re-checks URL policy at execution time');
    assert.ok(ipcSource.includes('parseActPayload'), 'act payload is parsed at the IPC boundary');
    assert.ok(ipcSource.includes('keysEqual'), 'act payload rejects unknown fields');
    assert.ok(ipcSource.includes('MAX_ACT_TEXT = 2_000'), 'type text is capped');
});

test('navigation commands enforce the embedded URL policy', () => {
    assert.ok(ipcSource.includes('normalizeEmbeddedBrowserUrl'), 'urls are normalized');
    assert.ok(ipcSource.includes('isAllowedEmbeddedBrowserUrl'), 'urls are policy-checked');
});

test('no page-side script execution is exposed by the embedded-browser IPC/CDP lane', () => {
    assert.ok(!/\.executeJavaScript\s*\(/.test(ipcSource));
    assert.ok(!/\.executeJavaScript\s*\(/.test(cdpSource));
    assert.ok(!/send\(contents,\s*['"]Runtime\.evaluate['"]/.test(cdpSource), 'CDP adapter must not call Runtime.evaluate');
    assert.ok(!cdpSource.includes('DOM.getOuterHTML'), 'picked-element metadata must not scrape raw outerHTML from logged-in pages');
});

test('main index wires registerBrowserIpc with the URL policy', () => {
    assert.ok(mainSource.includes('registerBrowserIpc({'), 'browser IPC registered');
    assert.ok(mainSource.includes('normalizeEmbeddedBrowserUrl: normalizeAllowedEmbeddedBrowserUrl'), 'policy injected');
});

test('main index marks owned webview guests on web-contents-created', () => {
    assert.match(mainSource, /if \(contents\.getType\(\) === 'webview'\) \{\s*markOwnedEmbeddedBrowserWebContents\(contents\);/);
});

test('destroyed guests are pruned from the registry', () => {
    assert.ok(ipcSource.includes("once('destroyed'"), 'destroyed listener prunes stale ids');
});
