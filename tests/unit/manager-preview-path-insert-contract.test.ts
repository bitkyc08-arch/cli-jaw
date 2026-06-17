import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const instancePreviewSource = readFileSync('public/manager/src/InstancePreview.tsx', 'utf8');
const previewParentSource = readFileSync('public/js/preview-parent-origin.ts', 'utf8');
const mainSource = readFileSync('public/js/main.ts', 'utf8');
const cssSource = readFileSync('public/manager/src/manager-components.css', 'utf8');

test('preview panel accepts FolderPanel path drops through postMessage with clipboard fallback', () => {
    assert.ok(instancePreviewSource.includes('hasFolderPanelDragPayload(event.dataTransfer)'), 'preview dragover must detect FolderPanel payloads');
    assert.ok(instancePreviewSource.includes('readFolderPanelDragPayload(event.dataTransfer)'), 'preview drop must read FolderPanel payloads');
    assert.ok(instancePreviewSource.includes('postPreviewInsertText'), 'preview drop must attempt focused text insertion first');
    assert.ok(instancePreviewSource.includes('copyText(insertedText)'), 'preview drop must fall back to clipboard copy');
    assert.ok(instancePreviewSource.includes("payload.entries.map(entry => entry.path).join('\\n')"), 'preview drop must insert multi-selection paths on separate lines');
    assert.ok(instancePreviewSource.includes('jaw-folder-panel-drag'), 'preview must listen for active FolderPanel drags');
    assert.ok(instancePreviewSource.includes('preview-path-drop-overlay'), 'preview must render a parent-owned drop overlay above the iframe during folder drags');
    assert.ok(instancePreviewSource.includes('jaw-preview-insert-text'), 'preview insert request message type must be explicit');
    assert.ok(instancePreviewSource.includes('jaw-preview-insert-text-result'), 'preview insert result message type must be explicit');
});

test('preview iframe installs a focused editable text insertion listener', () => {
    assert.ok(previewParentSource.includes('ensurePreviewInsertTextListener'), 'preview runtime must expose an insert listener installer');
    assert.ok(previewParentSource.includes('insertIntoEditable'), 'preview runtime must insert into focused text targets');
    assert.ok(previewParentSource.includes('jaw-preview-insert-text'), 'preview runtime must listen for the insert message');
    assert.ok(previewParentSource.includes('jaw-preview-insert-text-result'), 'preview runtime must acknowledge insert results');
    assert.ok(mainSource.includes('ensurePreviewInsertTextListener()'), 'preview bootstrap must install the listener');
    assert.ok(cssSource.includes('.preview-path-drop-status'), 'manager UI must surface preview drop fallback state');
    assert.ok(cssSource.includes('.preview-path-drop-overlay'), 'manager UI must provide a drop target overlay above preview iframes');
});
