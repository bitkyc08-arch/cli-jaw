import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composerSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt-composer.ts'), 'utf8');
const chatgptSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt.ts'), 'utf8');

test('BWCOMP-001: ChatGPT composer uses user-input insertion path', () => {
    assert.match(chatgptSrc, /Input\.insertText/);
    assert.match(composerSrc, /insertTextLikeOracle/);
    assert.doesNotMatch(chatgptSrc, /await fillComposer/);
    assert.doesNotMatch(chatgptSrc, /locator\.fill/);
});

test('BWCOMP-002: send button is primary and Enter is fallback', () => {
    assert.match(composerSrc, /SEND_BUTTON_SELECTORS/);
    assert.match(composerSrc, /button\[data-testid="send-button"\]/);
    assert.match(composerSrc, /dispatchClickSequence/);
    assert.match(composerSrc, /pointerdown/);
    assert.match(composerSrc, /mousedown/);
    assert.match(composerSrc, /submitPromptFromComposer/);
    assert.match(composerSrc, /keyboard\.press\('Enter'\)/);
});

test('BWCOMP-003: composer verification reads multiple paths', () => {
    assert.match(composerSrc, /editorText/);
    assert.match(composerSrc, /fallbackValue/);
    assert.match(composerSrc, /activeValue/);
    assert.match(composerSrc, /normalizePrompt\(expected\)/);
});

test('BWCOMP-004: composer selection prefers visible candidates like Oracle', () => {
    assert.match(composerSrc, /isLocatorVisible/);
    assert.match(composerSrc, /firstCandidate/);
    assert.match(composerSrc, /baseLocator\.nth/);
});

test('BWCOMP-005: prompt commit verification checks post-send conversation state', () => {
    assert.match(composerSrc, /CONVERSATION_TURN_SELECTOR/);
    assert.match(composerSrc, /STOP_BUTTON_SELECTOR/);
    assert.match(composerSrc, /ASSISTANT_ROLE_SELECTOR/);
    assert.match(composerSrc, /composerCleared/);
});

test('BWCOMP-006: file upload remains explicit fail-closed until PRD32.7 Phase B', () => {
    const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');
    assert.match(cliSrc, /--file is fail-closed/);
    assert.match(cliSrc, /Use --inline-only/);
});
