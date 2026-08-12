import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:3457/' });

Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => undefined },
});

const manifestUrls: string[] = [];
globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/api/auth/token')) {
        return new Response(JSON.stringify({ token: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    manifestUrls.push(url);
    return new Response(JSON.stringify({
        ok: true,
        data: { json: '{}', botDisplayName: 'derived-bot' },
    }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
};

const { openChannelOnboarding } = await import('../../public/js/features/channel-onboarding.ts');

function input(): HTMLInputElement {
    return document.querySelector('[data-onboard-app-name]') as HTMLInputElement;
}

function generateButton(): HTMLButtonElement {
    return document.querySelector('[data-onboard-generate-manifest]') as HTMLButtonElement;
}

function status(): HTMLElement {
    return document.querySelector('[data-onboard-manifest-status]') as HTMLElement;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail('timed out waiting for the onboarding click path');
}

async function submitAppName(value: string): Promise<void> {
    input().value = value;
    generateButton().click();
    await waitFor(() => manifestUrls.length > 0 || status().classList.contains('is-error'));
}

beforeEach(() => {
    manifestUrls.length = 0;
    openChannelOnboarding('slack');
});

test('COM-DOM-001: a spaced app name reaches the manifest route', async () => {
    await submitAppName('Demo App');
    assert.equal(manifestUrls.at(-1), '/api/slack/manifest?name=Demo%20App');
});

test('COM-DOM-002: a non-Latin app name reaches the route', async () => {
    await submitAppName('데모');
    assert.equal(manifestUrls.at(-1), `/api/slack/manifest?name=${encodeURIComponent('데모')}`);
});

test('COM-DOM-003: an empty name never calls the route', async () => {
    await submitAppName('');
    assert.equal(manifestUrls.length, 0);
    assert.equal(status().textContent, 'onboarding.slackAppNameError');
});

test('COM-DOM-004: an 18-emoji name passes the code-point cap that a code-unit cap would reject', async () => {
    const appName = '😀'.repeat(18);
    await submitAppName(appName);
    assert.equal(manifestUrls.at(-1), `/api/slack/manifest?name=${encodeURIComponent(appName)}`);
});

test('COM-DOM-005: a 36-code-point name is rejected', async () => {
    await submitAppName('x'.repeat(36));
    assert.equal(manifestUrls.length, 0);
    assert.equal(status().textContent, 'onboarding.slackAppNameError');
});
