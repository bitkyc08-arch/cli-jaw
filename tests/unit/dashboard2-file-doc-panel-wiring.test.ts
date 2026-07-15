import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fileTree = readFileSync('public/dashboard2/src/shell/panels/FileTreePanel.tsx', 'utf8');
const docPanel = readFileSync('public/dashboard2/src/features/panels/DocPanel.tsx', 'utf8');
const sidePane = readFileSync('public/dashboard2/src/shell/SidePane.tsx', 'utf8');

test('FileTree keeps directory toggles and routes file reads through openPanel', () => {
    assert.match(fileTree, /entry\.isDirectory \? toggleDirectory\(entry\) : void openFile\(entry\)/);
    assert.match(fileTree, /nativeFolder\.readFile\(entry\.path\)/);
    assert.match(fileTree, /openPanel\(\{[\s\S]*type: 'doc',[\s\S]*key: entry\.path,[\s\S]*content: result\.content/);
    assert.match(fileTree, /fileRequestGeneration\.current !== generation/);
    assert.match(fileTree, /setFileError\(\{ entry, message:/);
    assert.match(fileTree, />Retry<\/button>/);
});

test('DocPanel treats native shell payload as canonical and reports binary/truncated states', () => {
    assert.match(docPanel, /source: 'native-file' \| 'notes'/);
    assert.match(docPanel, /source === 'native-file' \? payload\.content \?\? '' : content/);
    assert.match(docPanel, /if \(source !== 'notes'/, 'notes fetch must be an explicit source adapter');
    assert.match(docPanel, /Truncated preview/);
    assert.match(docPanel, /Binary preview is not supported/);
    assert.match(sidePane, /<LazyDocPanel active=\{active\} source="native-file" payload=\{payload\}/);
});

test('089.05 adds diff without changing the 089.04 doc/design wiring', () => {
    assert.match(sidePane, /id: 'doc'/);
    assert.match(sidePane, /id: 'design'/);
    // 089.05 now owns the previously forbidden descriptor and lazy mount.
    assert.match(sidePane, /id: 'diff'/);
    assert.match(sidePane, /LazyDiffPanel/);
});
