// 260725 wp3 — ChatView state must belong to the session that produced it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test('a failed Stop tells the user instead of pretending it worked', () => {
    const chatView = read('public/dashboard2/src/chat/ChatView.tsx');
    const onStop = chatView.match(/onStop=\{[\s\S]{0,600}?\}\}/)?.[0] ?? '';

    assert.ok(onStop, 'the stop handler must exist');
    // Swallowing this is worse than most silent catches: the agent keeps running
    // while the UI implies it stopped.
    assert.equal(
        /catch\(\(\) => \{ \/\* snapshot recovers \*\/ \}\)/.test(onStop),
        false,
        'a stop failure must not be discarded',
    );
    assert.match(onStop, /onEcho\(/, 'the failure must reach the user through the echo lane');
    assert.match(onStop, /status: 'error'/, 'and be marked as an error');
});

test('echoes do not survive a session switch', () => {
    const chatView = read('public/dashboard2/src/chat/ChatView.tsx');

    // ChatView is reused across scope changes, so a sending/failed echo from the
    // previous session would otherwise render under the new one.
    assert.match(
        chatView,
        /useEffect\(\(\) => \{ setEchoes\(\[\]\); \}, \[scopeKey\]\)/,
        'switching sessions must clear echoes belonging to the old one',
    );
});
