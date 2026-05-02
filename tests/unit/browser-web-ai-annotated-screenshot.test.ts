import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAnnotatedScreenshot,
    summarizeScreenshotForDoctor,
} from '../../src/browser/web-ai/annotated-screenshot.ts';
import { WebAiError } from '../../src/browser/web-ai/errors.ts';

function makeMockPage() {
    return {
        url: () => 'https://example.com/',
        screenshot: async () => Buffer.from('fake-png'),
        evaluate: async () => [],
        locator: () => ({
            boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 50 }),
        }),
    };
}

test('ANN-SCR-001: buildAnnotatedScreenshot returns result with metadata', async () => {
    const page = makeMockPage();
    const result = await buildAnnotatedScreenshot(page as any);
    assert.ok(result.screenshotId.startsWith('scr-'));
    assert.equal(result.provider, null);
    assert.equal(result.url, 'https://example.com/');
    assert.ok(result.imageHash.startsWith('sha256:'));
    assert.equal(result.format, 'png');
    assert.equal(result.highlightCount, 0);
    assert.ok(result.timestamp);
});

test('ANN-SCR-002: buildAnnotatedScreenshot passes provider through', async () => {
    const page = makeMockPage();
    const result = await buildAnnotatedScreenshot(page as any, { provider: 'chatgpt' });
    assert.equal(result.provider, 'chatgpt');
});

test('ANN-SCR-003: buildAnnotatedScreenshot throws when screenshot unavailable', async () => {
    const page = { url: () => 'https://example.com/' };
    await assert.rejects(
        async () => buildAnnotatedScreenshot(page as any),
        (err: unknown) => err instanceof WebAiError && (err as WebAiError).errorCode === 'screenshot.unavailable',
    );
});

test('ANN-SCR-004: buildAnnotatedScreenshot wraps capture errors', async () => {
    const page = {
        url: () => 'https://example.com/',
        screenshot: async () => { throw new Error('screenshot failed'); },
    };
    await assert.rejects(
        async () => buildAnnotatedScreenshot(page as any),
        (err: unknown) => err instanceof WebAiError && (err as WebAiError).errorCode === 'screenshot.capture-failed',
    );
});

test('ANN-SCR-005: summarizeScreenshotForDoctor returns safe summary', () => {
    const result = {
        screenshotId: 'scr-1',
        imageHash: 'sha256:abc',
        width: 1920,
        height: 1080,
        highlightCount: 3,
        provider: null,
        url: null,
        format: 'png' as const,
        timestamp: '2026-05-02T00:00:00Z',
    };
    const summary = summarizeScreenshotForDoctor(result);
    assert.equal(summary.enabled, true);
    assert.equal(summary.screenshotId, 'scr-1');
    assert.equal(summary.imageHash, 'sha256:abc');
    assert.equal(summary.width, 1920);
    assert.equal(summary.height, 1080);
    assert.equal(summary.highlightCount, 3);
});

test('ANN-SCR-006: summarizeScreenshotForDoctor handles null', () => {
    const summary = summarizeScreenshotForDoctor(null);
    assert.equal(summary.enabled, true);
    assert.equal(summary.screenshotId, null);
    assert.equal(summary.imageHash, null);
    assert.equal(summary.width, 0);
    assert.equal(summary.height, 0);
    assert.equal(summary.highlightCount, 0);
});
