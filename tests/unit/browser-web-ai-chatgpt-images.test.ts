import test from 'node:test';
import assert from 'node:assert/strict';
import {
    deriveGeneratedImageOutputPaths,
    isAllowedChatGptImageUrl,
    resolveGeneratedImageWaitTimeoutMs,
    isImageOnlyGeneratedImageChromeText,
    buildGeneratedImageDetectionExpression,
    detectGeneratedImages,
    collectImages,
} from '../../src/browser/web-ai/chatgpt-images.ts';
import type { CdpSendSession } from '../../src/browser/web-ai/chatgpt-project-sources.ts';

const ESTUARY = 'https://chatgpt.com/backend-api/estuary/content?id=file_ABC-123';

// 102 generated images (P1): pure detection/path/url helpers + parse path.
test('BWAI-IMG-001: deriveGeneratedImageOutputPaths numbers siblings, preserves ext', () => {
    assert.deepEqual(deriveGeneratedImageOutputPaths('out.png', 1), ['out.png']);
    assert.deepEqual(deriveGeneratedImageOutputPaths('out.png', 3), ['out.png', 'out-2.png', 'out-3.png']);
    assert.deepEqual(deriveGeneratedImageOutputPaths('/a/b.jpeg', 2), ['/a/b.jpeg', '/a/b-2.jpeg']);
    assert.deepEqual(deriveGeneratedImageOutputPaths('out', 2), ['out', 'out-2']);
});

test('BWAI-IMG-002: isAllowedChatGptImageUrl only trusts chatgpt.com estuary urls', () => {
    assert.equal(isAllowedChatGptImageUrl(ESTUARY), true);
    assert.equal(isAllowedChatGptImageUrl('https://evil.com/backend-api/estuary/content?id=file_x'), false);
    assert.equal(isAllowedChatGptImageUrl('https://chatgpt.com/c/abc'), false);
    assert.equal(isAllowedChatGptImageUrl('not a url'), false);
});

test('BWAI-IMG-003: resolveGeneratedImageWaitTimeoutMs defaults & clamps', () => {
    assert.equal(resolveGeneratedImageWaitTimeoutMs('nope'), 60_000);
    assert.equal(resolveGeneratedImageWaitTimeoutMs(0), 60_000);
    assert.equal(resolveGeneratedImageWaitTimeoutMs(-5), 60_000);
    assert.equal(resolveGeneratedImageWaitTimeoutMs(1000), 5_000); // min clamp
    assert.equal(resolveGeneratedImageWaitTimeoutMs(90_000), 90_000);
});

test('BWAI-IMG-004: isImageOnlyGeneratedImageChromeText treats UI chrome as non-answer', () => {
    assert.equal(isImageOnlyGeneratedImageChromeText(''), true);
    assert.equal(isImageOnlyGeneratedImageChromeText('Edit'), true);
    assert.equal(isImageOnlyGeneratedImageChromeText('Creating image'), true);
    assert.equal(isImageOnlyGeneratedImageChromeText('Stopped thinking'), true);
    assert.equal(isImageOnlyGeneratedImageChromeText('Stopped thinking  Edit'), true);
    assert.equal(isImageOnlyGeneratedImageChromeText('Here is your analysis'), false);
});

test('BWAI-IMG-005: detection expression embeds baseline index + estuary anchor', () => {
    assert.match(buildGeneratedImageDetectionExpression(2), /MIN_ASSISTANT_INDEX = 2/);
    assert.match(buildGeneratedImageDetectionExpression(), /MIN_ASSISTANT_INDEX = 0/);
    assert.match(buildGeneratedImageDetectionExpression(-3), /MIN_ASSISTANT_INDEX = 0/); // floored to >= 0
    assert.match(buildGeneratedImageDetectionExpression(1), /estuary\/content/);
});

test('BWAI-IMG-006: detectGeneratedImages parses returnByValue array + filters incomplete', async () => {
    const cdp: CdpSendSession = {
        async send() {
            return {
                result: {
                    value: [
                        { url: ESTUARY, fileId: 'file_ABC-123', alt: 'Generated image', width: 1024, height: 1024 },
                        { url: '', fileId: 'file_x' }, // dropped (no url)
                        { url: ESTUARY, fileId: '' }, // dropped (no fileId)
                    ],
                },
            };
        },
    };
    const imgs = await detectGeneratedImages(cdp, { baselineAssistantCount: 0 });
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0]!.fileId, 'file_ABC-123');
    assert.equal(imgs[0]!.width, 1024);
});

test('BWAI-IMG-007: detectGeneratedImages handles a JSON-string value and empty', async () => {
    const strCdp: CdpSendSession = {
        async send() { return { result: { value: JSON.stringify([{ url: ESTUARY, fileId: 'file_Q' }]) } }; },
    };
    assert.equal((await detectGeneratedImages(strCdp)).length, 1);

    const emptyCdp: CdpSendSession = { async send() { return { result: { value: null } }; } };
    assert.deepEqual(await detectGeneratedImages(emptyCdp), []);
});

test('BWAI-IMG-008: collectImages with no output/session does not wait and returns empty', async () => {
    const cdp: CdpSendSession = { async send() { return { result: { value: [] } }; } };
    const out = await collectImages(cdp, {});
    assert.deepEqual(out.images, []);
    assert.deepEqual(out.savedPaths, []);
    assert.equal(out.explicitOutputRequested, false);
    assert.deepEqual(out.errors, []); // implicit + no images → silent
});
