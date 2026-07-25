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

test('a late echo from the previous session is rejected, not re-inserted', () => {
    const chatView = read('public/dashboard2/src/chat/ChatView.tsx');

    // Clearing on switch is not sufficient: the old Composer's send controller
    // aborts asynchronously and its catch still fires onEcho afterwards, which
    // would drop a stale error into the NEW session's list.
    assert.match(chatView, /makeEchoHandler/, 'the handler must be created per scope');
    const handler = chatView.match(/const makeEchoHandler[\s\S]{0,500}?\}, \[\]\)/)?.[0] ?? '';
    assert.ok(handler, 'the factory must exist');
    assert.match(handler, /liveScopeRef\.current !== forScope/, 'and must drop echoes stamped with a dead scope');
});

test('the stop echo uses a valid send source', () => {
    const chatView = read('public/dashboard2/src/chat/ChatView.tsx');
    const sendController = read('public/dashboard2/src/chat/composer/send-controller.ts');

    // 'composer' is not a SendSource; using it compiled under vite but failed
    // typecheck, which is the gate that would have caught it in CI.
    const sources = sendController.match(/export type SendSource = ([^;]+);/)?.[1] ?? '';
    const stopEcho = chatView.match(/onStop=\{[\s\S]{0,600}?\}\}/)?.[0] ?? '';
    const used = stopEcho.match(/source: '([a-z]+)'/)?.[1] ?? '';
    assert.ok(used, 'the stop echo must declare a source');
    assert.ok(sources.includes(`'${used}'`), `source '${used}' must be one of ${sources.trim()}`);
});
