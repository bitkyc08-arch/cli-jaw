import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    FOLDER_PANEL_DRAG_MIME,
    decodeFolderPanelDragPayload,
    encodeFolderPanelDragPayload,
    hasFolderPanelDragPayload,
    readFolderPanelDragPayload,
    shellEscapePath,
} from '../../public/manager/src/folder-panel/folder-drag-payload.js';

const terminalPanelSource = readFileSync('public/manager/src/terminal/TerminalPanel.tsx', 'utf8');
const folderPanelSource = readFileSync('public/manager/src/folder-panel/FolderPanel.tsx', 'utf8');
const folderRowsSource = readFileSync('public/manager/src/folder-panel/FolderTreeRows.tsx', 'utf8');

test('folder drag payload round-trips folder entries', () => {
    const encoded = encodeFolderPanelDragPayload({
        path: '/Users/jun/My Folder',
        name: 'My Folder',
        kind: 'directory',
        size: 0,
    });

    assert.deepEqual(decodeFolderPanelDragPayload(encoded), {
        path: '/Users/jun/My Folder',
        name: 'My Folder',
        kind: 'directory',
    });
});

test('folder drag payload rejects invalid data', () => {
    assert.equal(decodeFolderPanelDragPayload('not-json'), null);
    assert.equal(decodeFolderPanelDragPayload(JSON.stringify({ path: '/x', name: 'x', kind: 'link' })), null);
    assert.equal(decodeFolderPanelDragPayload(JSON.stringify({ path: '', name: 'x', kind: 'file' })), null);
});

test('folder drag payload presence checks MIME types without reading data', () => {
    const valid = {
        types: [FOLDER_PANEL_DRAG_MIME],
        getData() {
            throw new Error('dragover must not read payload data');
        },
    } as unknown as DataTransfer;
    const invalid = { types: ['text/plain'] } as unknown as DataTransfer;

    assert.equal(hasFolderPanelDragPayload(valid), true);
    assert.equal(hasFolderPanelDragPayload(invalid), false);
});

test('folder drag payload reads data only for recognized drops', () => {
    const encoded = JSON.stringify({ path: '/tmp/a', name: 'a', kind: 'file' });
    const valid = {
        types: [FOLDER_PANEL_DRAG_MIME],
        getData: (mime: string) => mime === FOLDER_PANEL_DRAG_MIME ? encoded : '',
    } as unknown as DataTransfer;

    assert.deepEqual(readFolderPanelDragPayload(valid), { path: '/tmp/a', name: 'a', kind: 'file' });
    assert.equal(readFolderPanelDragPayload({ types: ['text/plain'] } as unknown as DataTransfer), null);
});

test('shell escaping uses single quoted paths', () => {
    assert.equal(shellEscapePath('/Users/jun/My File.txt'), "'/Users/jun/My File.txt'");
    assert.equal(shellEscapePath("/tmp/a'b"), "'/tmp/a'\\''b'");
});

test('terminal panel handles folder payload drops through target terminal ids', () => {
    assert.ok(terminalPanelSource.includes('hasFolderPanelDragPayload(event.dataTransfer)'), 'dragover must check MIME presence without reading payload');
    assert.ok(terminalPanelSource.includes('readFolderPanelDragPayload(event.dataTransfer)'), 'drop must decode payload data');
    assert.ok(terminalPanelSource.includes('data-terminal-id={tab.id}'), 'terminal surfaces must expose stable tab ids');
    assert.ok(terminalPanelSource.includes('bridge.write(targetId'), 'drop must write to the resolved terminal tab');
    assert.ok(terminalPanelSource.includes('droppedPaths.map(shellEscapePath).join'), 'drop must shell-escape inserted paths');
    assert.ok(terminalPanelSource.includes("event.dataTransfer.dropEffect = 'copy'"), 'terminal dragover must advertise copy semantics');
});

test('folder panel emits JSON drag payloads and plain text path fallback', () => {
    assert.ok(folderPanelSource.includes('<FolderPanelTree'), 'FolderPanel must render the extracted folder tree component');
    assert.ok(folderRowsSource.includes('encodeFolderPanelDragPayload(dragSelection)'), 'FolderPanel rows must serialize structured drag payloads');
    assert.ok(folderRowsSource.includes("event.dataTransfer.effectAllowed = 'copyMove'"), 'FolderPanel source must allow copy targets and move targets');
    assert.ok(folderRowsSource.includes("event.dataTransfer.setData('text/plain', dragSelection.entries.map(item => item.path).join('\\n'))"), 'FolderPanel must preserve plain text path fallback');
});
