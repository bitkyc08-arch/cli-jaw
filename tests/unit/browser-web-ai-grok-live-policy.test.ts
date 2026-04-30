import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGrokUrl } from '../../src/browser/web-ai/grok-live.ts';

const root = process.cwd();
const grokLiveSrc = readFileSync(join(root, 'src/browser/web-ai/grok-live.ts'), 'utf8');
const copyMarkdownSrc = readFileSync(join(root, 'src/browser/web-ai/copy-markdown.ts'), 'utf8');
const grokModelSrc = readFileSync(join(root, 'src/browser/web-ai/grok-model.ts'), 'utf8');

test('BWAG-001: Grok live runtime gates by grok.com host', () => {
    assert.equal(isGrokUrl('https://grok.com/'), true);
    assert.equal(isGrokUrl('https://www.grok.com/chat'), true);
    assert.equal(isGrokUrl('https://chatgpt.com/'), false);
});

test('BWAG-002: Grok live runtime uses observed DOM selectors', () => {
    assert.match(grokLiveSrc, /\.ProseMirror\[contenteditable="true"\]/);
    assert.match(grokLiveSrc, /\[data-testid="new-chat"\]/);
    assert.match(grokLiveSrc, /\[data-testid="assistant-message"\]/);
    assert.match(grokLiveSrc, /response-content-markdown/);
});

test('BWAG-003: Grok upload uses visible chip and sent-turn evidence', () => {
    assert.match(grokLiveSrc, /attachLocalFileLive/);
    assert.match(grokLiveSrc, /verifyGrokSentTurnAttachment/);
    assert.match(grokLiveSrc, /closest\('\[id\^="response-"\]'\)/);
    assert.match(grokLiveSrc, /waitForTimeout\(250\)/);
    assert.match(grokLiveSrc, /Grok sent turn has no attachment evidence/);
    assert.match(grokLiveSrc, /data-testid\*="file"/);
});

test('BWAG-004: Grok supports opt-in copy markdown fallback', () => {
    assert.match(copyMarkdownSrc, /GROK_COPY_SELECTORS/);
    assert.match(copyMarkdownSrc, /\[data-testid="assistant-message"\]/);
    assert.match(copyMarkdownSrc, /button\[aria-label="Copy"\]/);
    assert.match(grokLiveSrc, /captureCopiedResponseText\(page, GROK_COPY_SELECTORS\)/);
    assert.match(grokLiveSrc, /copy-markdown/);
});

test('BWAG-005: Grok supports observed model picker choices', () => {
    assert.match(grokModelSrc, /button\[aria-label="Model select"\]/);
    for (const label of ['auto', 'fast', 'expert', 'grok-4.3', 'heavy']) {
        assert.match(grokModelSrc, new RegExp(label.replace('.', '\\.')));
    }
    assert.match(grokLiveSrc, /selectGrokModel/);
    assert.match(grokLiveSrc, /model selected:/);
});
