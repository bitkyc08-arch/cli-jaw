import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import {
    scoreFileInputCandidate,
    isImageAttachmentPath,
    findFirstFileInput,
} from '../../src/browser/web-ai/chatgpt-upload-surface.ts';

interface FakeInput { count: number; accept?: string | null; multiple?: string | null; visible?: boolean }

function fakePage(inputs: Record<string, FakeInput>): Page {
    return {
        locator: (sel: string) => {
            const cfg = inputs[sel] ?? { count: 0 };
            return {
                first: () => ({
                    getAttribute: async (name: string) =>
                        name === 'accept' ? (cfg.accept ?? null) : name === 'multiple' ? (cfg.multiple ?? null) : null,
                    isVisible: async () => cfg.visible ?? false,
                }),
                count: async () => cfg.count,
            };
        },
    } as unknown as Page;
}

// 102 chatgpt-upload-surface: scored file-input candidate selection.
test('BWAI-UPLOAD-001: image-only input is disqualified for a non-image attachment', () => {
    assert.equal(
        scoreFileInputCandidate({ accept: 'image/png,image/jpeg' }, { isImageAttachment: false }),
        Number.NEGATIVE_INFINITY,
    );
});

test('BWAI-UPLOAD-002: image-only input gets a small bonus for an image attachment', () => {
    assert.equal(scoreFileInputCandidate({ accept: 'image/*' }, { isImageAttachment: true }), 3);
});

test('BWAI-UPLOAD-003: composer + visible + multiple stack', () => {
    assert.equal(
        scoreFileInputCandidate({ inComposer: true, visible: true, multiple: true }),
        35,
    );
    assert.equal(scoreFileInputCandidate({}), 0);
    assert.equal(scoreFileInputCandidate({ visible: true }), 10);
});

test('BWAI-UPLOAD-004: a non-image-only accept (mixed) is not disqualified', () => {
    // contains a non-image part → acceptsOnlyImages is false → scored normally
    assert.equal(scoreFileInputCandidate({ accept: 'image/png,application/pdf', visible: true }, { isImageAttachment: false }), 10);
});

test('BWAI-UPLOAD-005: isImageAttachmentPath by extension (case-insensitive)', () => {
    assert.equal(isImageAttachmentPath('/x/a.png'), true);
    assert.equal(isImageAttachmentPath('/x/a.JPEG'), true);
    assert.equal(isImageAttachmentPath('photo.HEIC'), true);
    assert.equal(isImageAttachmentPath('/x/doc.pdf'), false);
    assert.equal(isImageAttachmentPath('/x/noext'), false);
});

test('BWAI-UPLOAD-006: findFirstFileInput picks the highest-scoring present input', async () => {
    // main input present & visible & multiple → 35; bare input present but not visible → 0
    const page = fakePage({
        'main input[type="file"]': { count: 1, multiple: 'true', visible: true },
        'input[type="file"]': { count: 1, visible: false },
    });
    const best = await findFirstFileInput(page, { path: '/x/doc.pdf', basename: 'doc.pdf' });
    assert.equal(best, 'main input[type="file"]');
});

test('BWAI-UPLOAD-007: findFirstFileInput returns null when the only candidate is disqualified', async () => {
    // only an image-only input, attachment is a pdf → NEGATIVE_INFINITY → null
    const page = fakePage({
        'input[type="file"]': { count: 1, accept: 'image/png', visible: true },
    });
    const best = await findFirstFileInput(page, { path: '/x/doc.pdf', basename: 'doc.pdf' });
    assert.equal(best, null);
});
