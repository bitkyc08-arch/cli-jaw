import test from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS } from '../../src/browser/web-ai/chatgpt-composer.js';
import { UPLOAD_BUTTON_SELECTORS } from '../../src/browser/web-ai/chatgpt-attachments.js';

// 105.8: member-array drift — cli-jaw had narrowed these shared selector constants and lost
// resilience agbrowse kept. These assert the restored fallbacks are present.

test('BWAI-SELDRIFT-001: INPUT_SELECTORS includes the bare-textarea fallback', () => {
    assert.ok(INPUT_SELECTORS.includes('textarea:not([disabled])'), 'bare textarea fallback restored');
    // The narrower scoped variants stay (precision-first), the bare one is an additional fallback.
    assert.ok(INPUT_SELECTORS.includes('main textarea:not([disabled])'));
    assert.ok(INPUT_SELECTORS.includes('form textarea:not([disabled])'));
});

test('BWAI-SELDRIFT-002: SEND_BUTTON_SELECTORS includes the generic Send + form-submit fallbacks', () => {
    assert.ok(SEND_BUTTON_SELECTORS.includes('form button[type="submit"]'));
    assert.ok(SEND_BUTTON_SELECTORS.includes('button[aria-label*="Send" i]'));
    // specific testids stay ahead of the generic fallbacks
    assert.ok(SEND_BUTTON_SELECTORS.indexOf('button[data-testid="send-button"]') < SEND_BUTTON_SELECTORS.indexOf('button[aria-label*="Send" i]'));
});

test('BWAI-SELDRIFT-003: UPLOAD_BUTTON_SELECTORS includes the plus-btn testid + explicit/i18n labels', () => {
    assert.ok(UPLOAD_BUTTON_SELECTORS.includes('button[data-testid="composer-plus-btn"]'));
    assert.ok(UPLOAD_BUTTON_SELECTORS.includes('button[aria-label="Add files and more"]'));
    assert.ok(UPLOAD_BUTTON_SELECTORS.includes('button[aria-label="파일 추가 및 기타"]'), 'Korean upload label restored');
});
