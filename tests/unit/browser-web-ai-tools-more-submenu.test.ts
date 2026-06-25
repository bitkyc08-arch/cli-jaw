import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipAlreadyCheckedItem, MORE_MENU_LABELS } from '../../src/browser/web-ai/chatgpt-tools.ts';

// 8.10 (catalog 106): More/"더 보기" submenu + aria-checked confirmation.
test('BWAI-TOOLS-MORE-001: shouldSkipAlreadyCheckedItem only skips an explicit aria-checked="true"', () => {
    assert.equal(shouldSkipAlreadyCheckedItem('true'), true);
    assert.equal(shouldSkipAlreadyCheckedItem('false'), false);
    assert.equal(shouldSkipAlreadyCheckedItem(null), false);
    assert.equal(shouldSkipAlreadyCheckedItem('mixed'), false);
    assert.equal(shouldSkipAlreadyCheckedItem(''), false);
});

test('BWAI-TOOLS-MORE-002: MORE_MENU_LABELS covers the EN + KO "More" labels', () => {
    assert.ok(MORE_MENU_LABELS.includes('More'));
    assert.ok(MORE_MENU_LABELS.includes('더 보기'));
});
