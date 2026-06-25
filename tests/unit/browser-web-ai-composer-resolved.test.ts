import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { submitPromptFromComposer, findComposerCandidate } from '../../src/browser/web-ai/chatgpt-composer.js';
import { sendButtonTimeoutMs } from '../../src/browser/web-ai/chatgpt-attachments.js';

type ClickOpts = { timeout?: number; force?: boolean };

function makePage(button: { isVisible: () => Promise<boolean>; isEnabled: () => Promise<boolean>; click: (o?: ClickOpts) => Promise<void> }, extras: Partial<{ evaluate: unknown; press: (k: string) => Promise<void> }> = {}): Page {
    return {
        locator: () => ({ first: () => button }),
        evaluate: extras.evaluate ?? (async () => 'missing'),
        keyboard: { press: extras.press ?? (async () => { throw new Error('Enter should not be pressed'); }) },
        waitForTimeout: async () => undefined,
    } as unknown as Page;
}

// 104.12: a resolver-verified send target is clicked directly, bypassing the selector scan.
test('BWAI-COMPOSER-RESOLVED-001: resolved send target is clicked once and reported with selector+resolution', async () => {
    const clicks: ClickOpts[] = [];
    const page = makePage({
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async (o?: ClickOpts) => { clicks.push(o ?? {}); },
    });

    const res = await submitPromptFromComposer(page, { sendTarget: { selector: 'button#send', resolution: 'css-fallback' } });

    assert.equal(res.method, 'button');
    assert.equal(res.selector, 'button#send');
    assert.equal(res.resolution, 'css-fallback');
    assert.equal(clicks.length, 1, 'single click, no force-retry needed');
    assert.equal(clicks[0]?.force, undefined);
});

// 104.12: a normal click that throws falls back to a forced click before giving up.
test('BWAI-COMPOSER-RESOLVED-002: resolved click force-retries; absent resolution defaults to null', async () => {
    const forceFlags: Array<boolean> = [];
    let n = 0;
    const page = makePage({
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async (o?: ClickOpts) => { forceFlags.push(o?.force ?? false); n += 1; if (n === 1) throw new Error('intercepted'); },
    });

    const res = await submitPromptFromComposer(page, { sendTarget: { selector: 'b' } });

    assert.equal(res.method, 'button');
    assert.equal(res.resolution, null);
    assert.deepEqual(forceFlags, [false, true], 'first plain click, then forced retry');
});

// 104.12: an invisible resolved target does NOT win; submit falls through to the scan, then Enter.
test('BWAI-COMPOSER-RESOLVED-003: invisible resolved target falls through to keyboard Enter', async () => {
    let pressed = '';
    const page = makePage(
        { isVisible: async () => false, isEnabled: async () => true, click: async () => { throw new Error('should not click'); } },
        { evaluate: async () => 'missing', press: async (k: string) => { pressed = k; } },
    );

    const res = await submitPromptFromComposer(page, { sendTarget: { selector: 'b' } });

    assert.equal(res.method, 'enter');
    assert.equal(pressed, 'Enter');
});

// 104.12: a resolver-verified composer target short-circuits the selector scan in findComposerCandidate.
test('BWAI-COMPOSER-RESOLVED-004: composerTarget short-circuits candidate discovery', async () => {
    let scanned = false;
    const page = {
        locator: (sel: string) => ({ first: () => ({ __selector: sel }) }),
        evaluate: async () => { scanned = true; return []; },
    } as unknown as Page;

    const candidate = await findComposerCandidate(page, { composerTarget: { selector: '#my-composer' } });

    assert.equal(candidate.selector, '#my-composer');
    assert.equal(scanned, false, 'no selector scan when a resolved composer target is supplied');
});

// 104.12: upload-aware send-button timeout widens when files are attached.
test('BWAI-COMPOSER-RESOLVED-005: sendButtonTimeoutMs widens for attachments', () => {
    assert.equal(sendButtonTimeoutMs(), 20_000);
    assert.equal(sendButtonTimeoutMs([]), 20_000);
    assert.equal(sendButtonTimeoutMs(['a.png']), 45_000);
});
