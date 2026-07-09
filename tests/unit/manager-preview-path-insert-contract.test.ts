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
    assert.ok(instancePreviewSource.includes('postPreviewInsertText'), 'preview drop must attempt guarded text insertion first');
    assert.ok(instancePreviewSource.includes('copyText(insertedText)'), 'preview drop must fall back to clipboard copy');
    assert.ok(instancePreviewSource.includes("payload.entries.map(entry => entry.path).join('\\n')"), 'preview drop must insert multi-selection paths on separate lines');
    assert.ok(instancePreviewSource.includes('jaw-folder-panel-drag'), 'preview must listen for active FolderPanel drags');
    assert.ok(instancePreviewSource.includes('preview-path-drop-overlay'), 'preview must render a parent-owned drop overlay above the iframe during folder drags');
    assert.ok(instancePreviewSource.includes('jaw-preview-insert-text'), 'preview insert request message type must be explicit');
    assert.ok(instancePreviewSource.includes('jaw-preview-insert-text-result'), 'preview insert result message type must be explicit');
});

test('preview panel exposes browser comment text insertion through the same postMessage path', () => {
    assert.ok(instancePreviewSource.includes('export type PreviewInsertTextRequest'), 'preview insert requests must have a typed prop contract');
    assert.ok(instancePreviewSource.includes('previewInsertTextRequest?: PreviewInsertTextRequest | null'), 'InstancePreview must accept external insert requests');
    assert.ok(instancePreviewSource.includes('onPreviewInsertTextResult?:'), 'InstancePreview must report external insert results');
    assert.ok(instancePreviewSource.includes('postPreviewInsertText(iframeRef.current, state.src, request.text)'), 'external inserts must reuse the guarded iframe postMessage helper');
    assert.ok(instancePreviewSource.includes('selected instance preview is not mounted'), 'missing preview must be surfaced as an insert failure');
});

test('preview iframe installs a chat composer text insertion listener', () => {
    assert.ok(previewParentSource.includes('ensurePreviewInsertTextListener'), 'preview runtime must expose an insert listener installer');
    assert.ok(previewParentSource.includes('findPreviewInsertTarget'), 'preview runtime must find a target even when the chat input is not focused');
    assert.ok(previewParentSource.includes("'#chatInput'"), 'preview runtime must prefer the instance chat input');
    assert.ok(previewParentSource.includes("'textarea'"), 'preview runtime must fall back to visible textarea targets');
    assert.ok(previewParentSource.includes("'[contenteditable=\"true\"]'"), 'preview runtime must fall back to contenteditable targets');
    assert.ok(previewParentSource.includes('range.selectNodeContents(editable)'), 'contenteditable inserts must append when no selection is inside the target');
    assert.ok(previewParentSource.includes('const hasFocus = document.activeElement === target'), 'unfocused text inputs must append instead of inserting at stale selection offsets');
    assert.ok(previewParentSource.includes('insertIntoEditable'), 'preview runtime must insert into resolved text targets');
    assert.ok(previewParentSource.includes('jaw-preview-insert-text'), 'preview runtime must listen for the insert message');
    assert.ok(previewParentSource.includes('jaw-preview-insert-text-result'), 'preview runtime must acknowledge insert results');
    assert.ok(mainSource.includes('ensurePreviewInsertTextListener()'), 'preview bootstrap must install the listener');
    assert.ok(cssSource.includes('.preview-path-drop-status'), 'manager UI must surface preview drop fallback state');
    assert.ok(cssSource.includes('.preview-path-drop-overlay'), 'manager UI must provide a drop target overlay above preview iframes');
});

test('browser comment preview insert guidance does not require manual focus', () => {
    const routerSource = readFileSync('public/manager/src/SidebarRailRouter.tsx', 'utf8');
    assert.ok(routerSource.includes('Open the selected instance Preview tab before inserting a browser comment.'), 'hidden preview error should only require opening Preview');
    assert.ok(!routerSource.includes('focus its chat input first'), 'browser comment inserts should no longer instruct users to focus the chat input');
    assert.ok(!routerSource.includes('focus the selected instance chat input'), 'browser comment timeout copy should no longer require manual chat focus');
});
