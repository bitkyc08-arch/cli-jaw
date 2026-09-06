import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

const calls: string[] = [];
mock.module('../../public/js/features/session-hub.js', { namedExports: {
    withCurrentSessionQuery(path: string) { return path; },
} });
mock.module('../../public/js/features/chat-messages.js', { namedExports: {
    showSkeleton() {}, removeSkeleton() {},
} });
mock.module('../../public/js/api.js', { namedExports: {
    async api(path: string) {
        calls.push(path);
        assert.ok(path.startsWith('/api/i18n/'), 'status/name changes must never write or load runtime state');
        return { 'btn.stop': path.endsWith('/ko') ? '멈춤 (Stop)' : 'Stop', 'status.responding': 'Responding' };
    },
} });

let ui: typeof import('../../public/js/features/ui-status.ts');
let i18n: typeof import('../../public/js/features/i18n.ts');
let state: typeof import('../../public/js/state.ts')['state'];
test.before(async () => {
    setupWebUiDom();
    localStorage.setItem('claw_locale', 'ko');
    ui = await import('../../public/js/features/ui-status.ts');
    i18n = await import('../../public/js/features/i18n.ts');
    ({ state } = await import('../../public/js/state.ts'));
    await i18n.initI18n();
});
test.after(() => { resetWebUiDom(); mock.restoreAll(); });
test.beforeEach(() => { calls.length = 0; ui.setStatus('idle'); });

for (const status of ['running', 'steering']) {
    test(`${status} exposes Stop rather than the old Send name`, () => {
        const button = document.getElementById('btnSend')!;
        button.setAttribute('aria-label', 'Send message');
        ui.setStatus(status);
        assert.equal(button.getAttribute('aria-label'), '멈춤 (Stop)');
        assert.equal(button.getAttribute('data-i18n-aria'), 'btn.stop');
        assert.equal(button.classList.contains('stop-mode'), true);
        assert.equal(state.agentBusy, true);
        assert.deepEqual(calls, []);
    });
}

test('terminal statuses restore Send and remove the stale translation binding', () => {
    const button = document.getElementById('btnSend')!;
    for (const terminal of ['idle', 'error', 'stopped', 'done']) {
        ui.setStatus('running'); ui.setStatus(terminal); i18n.applyI18n();
        assert.equal(button.getAttribute('aria-label'), 'Send message', terminal);
        assert.equal(button.hasAttribute('data-i18n-aria'), false, terminal);
        assert.equal(button.classList.contains('stop-mode'), false, terminal);
        assert.equal(state.agentBusy, false, terminal);
    }
    assert.deepEqual(calls, []);
});

test('locale application keeps the Stop action while steering and cannot revive it after idle', async () => {
    const button = document.getElementById('btnSend')!;
    ui.setStatus('steering');
    localStorage.setItem('claw_locale', 'en');
    await i18n.initI18n();
    assert.equal(button.getAttribute('aria-label'), 'Stop');
    ui.setStatus('idle'); i18n.applyI18n();
    assert.equal(button.getAttribute('aria-label'), 'Send message');
    localStorage.setItem('claw_locale', 'ko'); await i18n.initI18n();
    assert.equal(button.getAttribute('aria-label'), 'Send message');
});

test('repeated state transitions keep the same actionable button and keyboard focus', () => {
    const button = document.getElementById('btnSend')!;
    button.focus();
    let clicked = 0;
    const click = () => { clicked++; };
    button.addEventListener('click', click);
    try {
        for (const status of ['running', 'running', 'steering', 'idle', 'running']) ui.setStatus(status);
        assert.equal(document.getElementById('btnSend'), button);
        assert.equal(document.activeElement, button);
        button.click();
        assert.equal(clicked, 1);
        assert.equal(button.getAttribute('aria-label'), '멈춤 (Stop)');
        assert.deepEqual(calls, []);
    } finally { button.removeEventListener('click', click); }
});
