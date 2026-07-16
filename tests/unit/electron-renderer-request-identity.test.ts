import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CLI_JAW_ELECTRON_HEADER,
    isCurrentLiveOwnedManagerGeneration,
    releaseOwnedManagerGeneration,
    rendererRequestHeaders,
    shouldInjectRendererRequestIdentity,
    type OwnedManagerProcessState,
    type RendererRequestDetails,
    type RendererRequestIdentityContext,
} from '../../electron/src/main/lib/renderer-request-identity.js';

const MANAGER_ORIGIN = 'http://127.0.0.1:24578';
const MAIN_WINDOW_ID = 17;

function child(overrides: Partial<OwnedManagerProcessState> = {}): OwnedManagerProcessState {
    return { exitCode: null, signalCode: null, killed: false, ...overrides };
}

function request(overrides: Partial<RendererRequestDetails> = {}): RendererRequestDetails {
    return {
        url: `${MANAGER_ORIGIN}/api/dashboard/desktop-status`,
        referrer: `${MANAGER_ORIGIN}/dashboard2/`,
        resourceType: 'xhr',
        webContentsId: MAIN_WINDOW_ID,
        frame: { parent: null, url: `${MANAGER_ORIGIN}/dashboard2/` },
        ...overrides,
    };
}

test('renderer identity is injected only for a live owned generation main-window same-origin XHR', () => {
    const owned = child();
    const allowed = shouldInjectRendererRequestIdentity(request(), {
        managerProcess: owned,
        managerOrigin: MANAGER_ORIGIN,
        mainWindowWebContentsId: MAIN_WINDOW_ID,
    });
    const original = { Accept: 'application/json', 'X-CLI-Jaw-Electron': 'spoofed' };
    const headers = rendererRequestHeaders(original, 'per-launch-token', allowed);

    assert.equal(allowed, true);
    assert.deepEqual(headers, {
        Accept: 'application/json',
        [CLI_JAW_ELECTRON_HEADER]: 'per-launch-token',
    });
    assert.equal(original['X-CLI-Jaw-Electron'], 'spoofed', 'request metadata must not be mutated in place');
});

test('attach, preview, webview, external, and non-XHR requests receive no renderer identity', () => {
    const live = child();
    const baseContext: RendererRequestIdentityContext = {
        managerProcess: live,
        managerOrigin: MANAGER_ORIGIN,
        mainWindowWebContentsId: MAIN_WINDOW_ID,
    };
    const denied: Array<[string, RendererRequestDetails, RendererRequestIdentityContext]> = [
        ['explicit attach has no owned child', request(), { ...baseContext, managerProcess: null }],
        ['preview URL is foreign', request({ url: 'http://127.0.0.1:3000/api' }), baseContext],
        ['preview frame URL is foreign', request({ frame: { parent: null, url: 'http://127.0.0.1:3000/' } }), baseContext],
        ['same-origin preview subframe is denied', request({ frame: { parent: {}, url: `${MANAGER_ORIGIN}/dashboard2/` } }), baseContext],
        ['missing frame is denied', request({ frame: null }), baseContext],
        ['webview has a foreign sender', request({ webContentsId: 88 }), baseContext],
        ['external URL is foreign', request({ url: 'https://example.com/api' }), baseContext],
        ['navigation is not XHR', request({ resourceType: 'mainFrame' }), baseContext],
        ['missing main window is denied', request(), { ...baseContext, mainWindowWebContentsId: null }],
    ];

    for (const [label, details, context] of denied) {
        assert.equal(shouldInjectRendererRequestIdentity(details, context), false, label);
        assert.deepEqual(
            rendererRequestHeaders({ 'x-cli-jaw-electron': 'spoofed' }, 'secret', false),
            {},
            `${label}: the desktop header must be stripped`,
        );
    }
});

test('no-referrer manager policy still allows a top-level manager frame XHR', () => {
    const owned = child();
    assert.equal(shouldInjectRendererRequestIdentity(request({ referrer: '' }), {
        managerProcess: owned,
        managerOrigin: MANAGER_ORIGIN,
        mainWindowWebContentsId: MAIN_WINDOW_ID,
    }), true);
});

test('only the current live child generation owns renderer identity', () => {
    const oldChild = child();
    const newChild = child();
    const exitedChild = child({ exitCode: 0 });
    const signaledChild = child({ signalCode: 'SIGTERM' });
    const killedChild = child({ killed: true });

    assert.equal(isCurrentLiveOwnedManagerGeneration(oldChild, oldChild), true);
    assert.equal(isCurrentLiveOwnedManagerGeneration(newChild, oldChild), false, 'stale generation is not current');
    assert.equal(isCurrentLiveOwnedManagerGeneration(exitedChild, exitedChild), false);
    assert.equal(isCurrentLiveOwnedManagerGeneration(signaledChild, signaledChild), false);
    assert.equal(isCurrentLiveOwnedManagerGeneration(killedChild, killedChild), false);

    assert.equal(releaseOwnedManagerGeneration(oldChild, oldChild), null, 'matching exit clears ownership');
    assert.equal(
        releaseOwnedManagerGeneration(newChild, oldChild),
        newChild,
        'late old-child exit cannot clear the new generation',
    );
});
