import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const geminiLiveSrc = readFileSync(join(root, 'src/browser/web-ai/gemini-live.ts'), 'utf8');
const geminiModelSrc = readFileSync(join(root, 'src/browser/web-ai/gemini-model.ts'), 'utf8');

test('GEM-LIVE-001: Gemini upload uses observed filechooser flow with evidence checks', () => {
    assert.match(geminiLiveSrc, /page\.waitForEvent\('filechooser'/);
    assert.match(geminiLiveSrc, /uploader-file-preview/);
    assert.match(geminiLiveSrc, /Gemini sent turn has no attachment evidence/);
    assert.match(geminiLiveSrc, /context package attached:/);
    assert.doesNotMatch(geminiLiveSrc, /gemini file\/context upload is not implemented/);
});

test('GEM-LIVE-002: Deep Think activation cannot silently degrade to default Gemini mode', () => {
    assert.match(geminiLiveSrc, /active Deep Think chip was not verified/);
    assert.doesNotMatch(geminiLiveSrc, /deep-think-not-activated/);
    assert.doesNotMatch(geminiLiveSrc, /default mode\)/);
});

test('GEM-LIVE-003: Gemini supports observed mode picker choices when --model is set', () => {
    assert.match(geminiModelSrc, /bard-mode-menu-button/);
    assert.match(geminiModelSrc, /bard-mode-option-fast/);
    assert.match(geminiModelSrc, /bard-mode-option-thinking/);
    assert.match(geminiModelSrc, /bard-mode-option-pro/);
    assert.match(geminiLiveSrc, /selectGeminiModel/);
    assert.match(geminiLiveSrc, /model selected:/);
});
