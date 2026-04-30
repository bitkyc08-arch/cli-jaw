import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composerSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt-composer.ts'), 'utf8');
const chatgptSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt.ts'), 'utf8');
const modelSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt-model.ts'), 'utf8');

test('BWCOMP-001: ChatGPT composer uses user-input insertion path', () => {
    assert.match(chatgptSrc, /Input\.insertText/);
    assert.match(composerSrc, /insertTextLikeProvider/);
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

test('BWCOMP-004: composer selection prefers visible candidates', () => {
    assert.match(composerSrc, /findVisibleCandidate/);
    assert.match(composerSrc, /allowFirstCandidateFallback: true/);
});

test('BWCOMP-005: prompt commit verification checks post-send conversation state', () => {
    assert.match(composerSrc, /CONVERSATION_TURN_SELECTOR/);
    assert.match(composerSrc, /STOP_BUTTON_SELECTOR/);
    assert.match(composerSrc, /ASSISTANT_ROLE_SELECTOR/);
    assert.match(composerSrc, /composerCleared/);
});

test('BWCOMP-006: file upload Phase B live runtime is exported', () => {
    const attSrc = fs.readFileSync(join(root, 'src/browser/web-ai/chatgpt-attachments.ts'), 'utf8');
    assert.match(attSrc, /attachLocalFileLive/);
    assert.match(attSrc, /waitForAttachmentAcceptedLive/);
    assert.match(attSrc, /verifySentTurnAttachmentLive/);
});

test('BWCOMP-007: ChatGPT model selector uses observed radio menu fallbacks', () => {
    assert.match(modelSrc, /model-switcher-dropdown-button/);
    assert.match(modelSrc, /__composer-pill/);
    assert.match(modelSrc, /composer-model-pill/);
    assert.match(modelSrc, /Instant\|Fast\|Thinking\|Pro\|Heavy/);
    assert.match(modelSrc, /model-switcher-gpt-5-3/);
    assert.match(modelSrc, /model-switcher-gpt-5-5-thinking/);
    assert.match(modelSrc, /model-switcher-gpt-5-5-pro/);
    assert.match(modelSrc, /model-switcher-gpt-5-5-pro-thinking-effort/);
    assert.match(modelSrc, /Heavy/);
    assert.match(modelSrc, /aria-checked="true"/);
    assert.match(chatgptSrc, /selectChatGptModel/);
});
