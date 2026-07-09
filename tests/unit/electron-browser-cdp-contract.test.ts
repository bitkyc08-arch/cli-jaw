/**
 * 030 v4/v5 -- Embedded browser CDP adapter contract (Electron main side).
 *
 * Locks in:
 * - the CDP adapter uses ONLY DOM/Overlay/Input/Accessibility domains
 * - it NEVER uses Runtime.evaluate or any script-execution path (030 ban)
 * - element inspect uses Overlay.setInspectMode + inspectNodeRequested
 * - interactive actions dispatch through the Input domain
 * - the IPC layer allows `act` for agent-visible tabs, gates by allowed URL, and
 *   validates the act payload
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const cdpSource = readFileSync(join(root, 'electron/src/main/lib/browser/cdp.ts'), 'utf-8');
const ipcSource = readFileSync(join(root, 'electron/src/main/lib/browser/ipc.ts'), 'utf-8');
const bridgeSource = readFileSync(join(root, 'public/manager/src/panels/desktop-bridge.ts'), 'utf-8');
const preloadSource = readFileSync(join(root, 'electron/src/preload/index.ts'), 'utf-8');

test('CDP adapter never CALLS Runtime.evaluate or executeJavaScript', () => {
    // The doc comment names Runtime.evaluate to say it is banned; assert no
    // actual protocol call or Runtime domain enable exists.
    assert.ok(!/send\([^)]*['"]Runtime\.(evaluate|callFunctionOn|enable)/.test(cdpSource), 'no Runtime.* protocol call');
    assert.ok(!cdpSource.includes("'Runtime.enable'"), 'Runtime domain is never enabled');
    // Page.getLayoutMetrics is used as a one-off read-only viewport probe, but
    // the Page domain must never be SUBSCRIBED (no events, no script hooks).
    assert.ok(!cdpSource.includes("'Page.enable'"), 'Page domain is never enabled');
    assert.ok(!cdpSource.includes('Page.addScriptToEvaluateOnNewDocument'), 'no page script injection');
    // Ban the actual API call `.executeJavaScript(` — the doc comment may name it.
    assert.ok(!/\.executeJavaScript\s*\(/.test(cdpSource), 'no executeJavaScript() call');
    assert.ok(!/\.executeJavaScript\s*\(/.test(ipcSource), 'ipc has no executeJavaScript() call');
});

test('CDP adapter only enables the allowed native domains', () => {
    // Element inspect + snapshot + input — the four native domains.
    assert.ok(cdpSource.includes("'DOM.enable'"), 'DOM domain');
    assert.ok(cdpSource.includes("'Overlay.enable'"), 'Overlay domain');
    assert.ok(cdpSource.includes('Overlay.setInspectMode'), 'native element inspect');
    assert.ok(cdpSource.includes('Overlay.inspectNodeRequested'), 'native element pick event');
    assert.ok(cdpSource.includes("DOM.describeNode', { backendNodeId"), 'native element pick resolves from backendNodeId');
    assert.ok(cdpSource.includes("DOM.getBoxModel', { backendNodeId"), 'native element pick bounds resolve from backendNodeId');
    assert.ok(cdpSource.includes("'Accessibility.getFullAXTree'"), 'AX snapshot');
    assert.ok(cdpSource.includes('Input.dispatchMouseEvent'), 'input mouse dispatch');
    assert.ok(cdpSource.includes('Input.insertText') || cdpSource.includes('Input.dispatchKeyEvent'), 'input key/type dispatch');
});

test('IPC act is full-permission for visible tabs and still gates URL + payload', () => {
    assert.equal(ipcSource.includes('if (!entry.actionsEnabled)'), false, 'act must not require a per-tab action opt-in');
    assert.equal(ipcSource.includes('actions not enabled for this tab'), false, 'action-disabled error must not remain');
    assert.ok(ipcSource.includes('isAllowedEmbeddedBrowserUrl(contents.getURL())'), 'act requires an allowed current page');
    assert.ok(ipcSource.includes('parseActPayload') || ipcSource.includes('normalizeActPayload'), 'act payload is validated');
    assert.ok(ipcSource.includes("case 'setActionsEnabled'"), 'legacy actions toggle remains accepted for compatibility');
});

test('CDP session detaches on webContents destruction', () => {
    assert.ok(ipcSource.includes('detachCdp('), 'CDP is detached when the guest goes away');
    assert.ok(cdpSource.includes("contents.debugger.detach()"), 'debugger detach on teardown');
});

test('bridge + preload expose the picked-element event and new actions', () => {
    assert.ok(bridgeSource.includes('onElementPicked'), 'bridge exposes the picked-element event');
    assert.ok(bridgeSource.includes("'startInspect'") && bridgeSource.includes("'act'"), 'bridge action union includes inspect + act');
    assert.ok(preloadSource.includes('browser:element-picked'), 'preload wires the picked-element channel');
});
