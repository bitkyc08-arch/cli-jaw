// #233 — instance web UI header "Project …" contracts (static, same pattern
// as web-refresh-state-recovery.test.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const wsSrc = readFileSync(join(root, 'public/js/ws.ts'), 'utf8');
const coreSrc = readFileSync(join(root, 'public/js/features/settings-core.ts'), 'utf8');
const htmlSrc = readFileSync(join(root, 'public/index.html'), 'utf8');

test('WHP-001: header markup has the project segment next to headerCli', () => {
    assert.ok(htmlSrc.includes('id="headerProject"'), 'headerProject span must exist');
    assert.ok(htmlSrc.includes('id="headerGitStatus"'), 'headerGitStatus span must exist');
    const headerLine = htmlSrc.split('\n').find(l => l.includes('id="headerCli"'));
    assert.ok(headerLine && headerLine.includes('id="headerProject"'), 'project segment must sit in the same header span');
    assert.ok(headerLine && headerLine.includes('id="headerGitStatus"'), 'git segment must sit in the same header span');
});

test('WHP-002: settings_change updates the header without reloading settings', () => {
    const idx = wsSrc.indexOf("msg.type === 'settings_change'");
    assert.ok(idx > 0, 'ws dispatcher must handle settings_change');
    const handlerIdx = wsSrc.indexOf('function handleSettingsChange');
    assert.ok(handlerIdx > 0, 'ws must centralize settings_change handling');
    const block = wsSrc.slice(handlerIdx, handlerIdx + 1400);
    assert.ok(block.includes("syncOrchestrateSnapshot('settings_change')"), 'existing snapshot sync must stay');
    assert.ok(block.includes('refreshHeaderFromSettingsChange'), 'header must refresh from the event payload');
    assert.ok(!block.includes('loadSettings('), 'must not re-run the full settings load per event');
});

test('WHP-005: scope-affecting settings_change reloads history before snapshot', () => {
    // devlog 260609 78/82 — message scope is keyed on workingDir; the event
    // payload always carries projectDirs, so the gate must use changedKeys.
    const handlerIdx = wsSrc.indexOf('function handleSettingsChange');
    assert.ok(handlerIdx > 0, 'ws must centralize settings_change handling');
    const block = wsSrc.slice(handlerIdx, handlerIdx + 1400);
    assert.ok(block.includes('changedKeys'), 'gate must read the changedKeys payload, not key presence');
    assert.ok(block.includes("changedKeys.includes('workingDir')"), 'workingDir is the message-scope key');
    assert.ok(block.includes("changedKeys.includes('projectDirs')"), 'projectDirs change must route through the scope-refresh path');
    assert.ok(block.includes('m.loadMessages()'), 'scope-affecting settings must reload durable history');
    assert.ok(block.indexOf('m.loadMessages()') < block.indexOf("await syncOrchestrateSnapshot('settings_change')"),
        'durable history must load before snapshot sync on scope changes');
    assert.ok(block.includes('lastLoadTs = Date.now()'), 'scope reload should update the reconnect reload throttle');
    assert.ok(!block.includes('snapshotReady ='),
        'settings path must not reassign snapshotReady — only channel-up/replay-gap own it');
});

test('WHP-003: settings-core renders the project label on load and on change', () => {
    assert.ok(coreSrc.includes('export function refreshHeaderFromSettingsChange'), 'header refresh entry must be exported');
    assert.ok(coreSrc.includes('setHeaderProject(s.projectDirs)'), 'loadSettings must render the project label');
    assert.ok(coreSrc.includes('loadHeaderGitStatus'), 'loadSettings must hydrate the project git header status');
    assert.ok(coreSrc.includes('refreshHeaderGitStatusFromSettingsChange'), 'settings_change must route to git header refresh');
    assert.ok(coreSrc.includes('formatProjectLabel'), 'must use the shared label formatter');
    const fnIdx = coreSrc.indexOf('function setHeaderProject');
    const block = coreSrc.slice(fnIdx, fnIdx + 700);
    assert.ok(block.includes("classList.add('is-empty')"), 'unset projectDirs must render the muted picker state');
    assert.ok(block.includes('Project: not set'), 'unset state must stay clickable, not hidden');
    assert.ok(block.includes('label.title'), 'full paths must land in the tooltip');
});

test('WHP-004: header label is a keyboard-accessible picker button', () => {
    const idx = coreSrc.indexOf('function ensureHeaderProjectPicker');
    assert.ok(idx > 0, 'picker binding must exist');
    const block = coreSrc.slice(idx, idx + 1600);
    assert.ok(block.includes("setAttribute('role', 'button')"), 'must expose button role');
    assert.ok(block.includes("setAttribute('tabindex', '0')"), 'must be focusable');
    assert.ok(block.includes("'/api/project/pick'"), 'click must call the pick endpoint');
    assert.ok(block.includes("addEventListener('keydown'"), 'Enter/Space must work');
});

test('WHP-006: git header refresh is gated by changedKeys, not projectDirs presence', () => {
    const projectGitSrc = readFileSync(join(root, 'public/js/features/project-git-status.ts'), 'utf8');
    const fnIdx = projectGitSrc.indexOf('export function refreshHeaderGitStatusFromSettingsChange');
    assert.ok(fnIdx > 0, 'git status refresh entry must exist');
    const block = projectGitSrc.slice(fnIdx, fnIdx + 500);
    assert.ok(block.includes('changedKeys.includes'), 'git status refresh must inspect changedKeys');
    assert.ok(block.includes("'projectDirs'"), 'projectDirs is the only settings key that triggers git status reload');
    assert.ok(!block.includes("'projectDirs' in msg"), 'must not refresh on projectDirs payload presence alone');
});
