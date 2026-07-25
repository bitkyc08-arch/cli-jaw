// 260725 wp2 — selecting a jwc conversation must actually open that conversation.
//
// Every row rendered conv.sessionId and conv.cwd but the click handler threw
// them away and called openSidePane(), so all rows did the same nothing. The
// existing test missed it by asserting exactly what the implementation did.
//
// The fix spans four files, so these assertions follow the intent end to end:
// sidebar builds it, SidePane reads it, the gate forwards it, CodeTab loads it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test('the sidebar sends the conversation identity, not just an open-pane call', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');
    const row = sidebar.match(/d2-jwc-conv-row[\s\S]{0,1400}?title=\{conv\.title\}/)?.[0] ?? '';

    assert.ok(row, 'the jwc conversation row must exist');
    assert.match(row, /openPanel\(/, 'clicking a conversation must open the code panel, not merely the pane');
    assert.match(row, /sessionId:\s*conv\.sessionId/, 'the row must pass the conversation it represents');
    assert.match(row, /cwd:\s*conv\.cwd/, 'and the working directory the session needs to load');
});

test('the port travels with the conversation', () => {
    const sidebar = read('public/dashboard2/src/shell/Sidebar.tsx');

    // The jwc list is fetched from a jwc runtime, which is not necessarily the
    // selected jaw instance, so the port cannot be re-derived downstream.
    assert.match(sidebar, /port:\s*number\s*\|\s*null/, 'jwc state must remember which port it listed');
    assert.match(sidebar, /port:\s*jwcState\.port/, 'and the click must forward that port');
});

test('SidePane reads the intent instead of ignoring the payload', () => {
    const sidePane = read('public/dashboard2/src/shell/SidePane.tsx');
    const codeCase = sidePane.match(/case 'code':[\s\S]{0,1200}?\n        }/)?.[0] ?? '';

    assert.ok(codeCase, 'the code panel branch must exist');
    assert.match(codeCase, /raw\['sessionId'\]/, 'the payload carries the conversation and must be read');
    assert.match(codeCase, /raw\['port'\]/, 'the payload port must win over the ambient selection');
    assert.match(codeCase, /sessionIntent/, 'and be handed to the code tab');
});

test('the gate forwards the intent rather than dropping it at the lazy boundary', () => {
    const gate = read('public/dashboard2/src/code/CodeTabGate.tsx');

    assert.match(gate, /sessionIntent\?:/, 'the gate must accept an intent');
    assert.match(gate, /LazyCodeTabImpl[^/]*sessionIntent/, 'and pass it through to the implementation');
});

test('CodeTab opens the requested conversation and re-opens on a different one', () => {
    const codeTab = read('public/dashboard2/src/code/CodeTab.tsx');

    assert.match(codeTab, /sessionIntent\?:\s*\{\s*sessionId: string;\s*cwd: string\s*\}/, 'CodeTab must accept the intent');
    assert.match(codeTab, /openStoredSession\(\{\s*sessionId: sessionIntent\.sessionId/, 'and route it through the existing load path');

    // Without keying on the intent, a second conversation opened into the same
    // panel would silently keep showing the first one.
    assert.match(codeTab, /intentKey/, 'the effect must key on the intent so a new conversation replaces the old');
    assert.match(codeTab, /appliedIntentRef/, 'and must not reload the same conversation on every render');
});
