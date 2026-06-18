import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function read(path: string): string {
    return readFileSync(join(ROOT, path), 'utf8');
}

test('code session stored rows use JWC title and first-message fallback instead of cwd primary fallback', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('storedSessionTitle'), 'CodeSessionList must centralize stored title fallback');
    assert.ok(list.includes("session.title?.trim()"), 'stored title must prefer JWC title');
    assert.ok(list.includes("session.firstMessage?.replace"), 'stored title must fall back to first user message when available');
    assert.ok(list.includes("session.sessionId.slice"), 'stored title must use a stable session id prefix after title/firstMessage');
    assert.equal(list.includes('s.title || cwdLabel(s.cwd)'), false, 'stored session primary title must not fall back to cwd basename');
    assert.ok(list.includes('storedSessionMeta'), 'cwd should move to secondary metadata');
});

test('code session live rows do not use cwd basename as primary title', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('liveSessionTitle'), 'CodeSessionList must centralize live title fallback');
    assert.ok(list.includes("session.title?.trim()"), 'live title must prefer returned JWC title when available');
    assert.ok(list.includes("session.sessionId.slice(0, 12)"), 'live title must fall back to stable session id prefix, not cwd');
    assert.ok(list.includes('liveSessionMeta'), 'live cwd should render as secondary metadata');
    assert.equal(list.includes('<span className="code-session-cwd">{cwdLabel(s.cwd)}</span>'), false, 'live session primary title must not be cwd basename');
});

test('code session list searches title firstMessage cwd and session id, then sorts before limit', () => {
    const list = read('public/manager/src/code/CodeSessionList.tsx');

    assert.ok(list.includes('storedSessionSearchText'), 'stored session search helper must exist');
    for (const token of ['session.sessionId', "session.title ?? ''", "session.firstMessage ?? ''", 'session.cwd']) {
        assert.ok(list.includes(token), `search helper must include ${token}`);
    }
    const sortIndex = list.indexOf('.sort((left, right) => storedSessionTime(right) - storedSessionTime(left))');
    const sliceIndex = list.indexOf('.slice(0, 20)');
    assert.ok(sortIndex > 0, 'stored sessions must sort by timestamp');
    assert.ok(sliceIndex > sortIndex, 'stored sessions must sort before applying visible limit');
    assert.ok(list.includes('Date.parse(session.updatedAt)'), 'stored timestamp must parse ACP updatedAt');
});

test('code canvas accepts replay user chunks and loads stored sessions without dropping replayed transcript', () => {
    const canvas = read('public/manager/src/code/CodeCanvas.tsx');

    assert.ok(canvas.includes("kind === 'code_user_message_chunk'"), 'CodeCanvas must handle replayed user message chunks');
    assert.ok(canvas.includes("role: 'user', text"), 'replayed user chunks must render as user transcript entries');

    const loadBlockStart = canvas.indexOf('onLoadSession={(id, cwd) => {');
    const loadBlockEnd = canvas.indexOf('onNewSession=', loadBlockStart);
    assert.ok(loadBlockStart > 0 && loadBlockEnd > loadBlockStart, 'stored session load handler must be present');
    const loadBlock = canvas.slice(loadBlockStart, loadBlockEnd);

    const refIndex = loadBlock.indexOf('activeSessionIdRef.current = id');
    const activeIndex = loadBlock.indexOf('setActiveSessionId(id)');
    const clearIndex = loadBlock.indexOf('setMessages([])');
    const loadIndex = loadBlock.indexOf('client.loadSession(id, cwd)');
    assert.ok(refIndex >= 0 && refIndex < loadIndex, 'activeSessionIdRef must be set before client.loadSession');
    assert.ok(activeIndex >= 0 && activeIndex < loadIndex, 'active session state must be set before client.loadSession');
    assert.ok(clearIndex >= 0 && clearIndex < loadIndex, 'transcript must be cleared before replay can arrive');
    assert.equal(loadBlock.indexOf('setMessages([])', loadIndex), -1, 'success path must not clear replayed transcript after load');
    assert.equal(loadBlock.indexOf("setSessionTitle('')", loadIndex), -1, 'success path must not clear loaded title after load');
    assert.ok(loadBlock.includes('const session = await client.loadSession(id, cwd)'), 'load handler must read returned session metadata');
    assert.ok(loadBlock.includes('if (session.title) setSessionTitle(session.title)'), 'load handler must preserve returned JWC title in header');
    assert.ok(loadBlock.includes('if (activeSessionIdRef.current === id)'), 'load failure must only restore state when failed id is still active');
});

test('code backend normalizes JWC session title metadata and returns title on load', () => {
    const types = read('src/code-mode/types.ts');
    const host = read('src/code-mode/acp-host.ts');
    const client = read('public/manager/src/code/code-session-client.ts');

    assert.ok(types.includes('title?: string;'), 'CodeSessionInfo must carry optional title');
    assert.ok(types.includes('StoredCodeSessionInfo'), 'stored session metadata type must exist');
    for (const token of ['firstMessage?: string', 'updatedAt?: string', 'messageCount?: number', 'size?: number']) {
        assert.ok(types.includes(token), `stored metadata type must include ${token}`);
        assert.ok(client.includes(token), `frontend stored metadata type must include ${token}`);
    }

    assert.ok(host.includes('function normalizeStoredSession'), 'ACP host must normalize stored session metadata');
    assert.ok(host.includes("stringField(raw['title'])"), 'backend must normalize title');
    assert.ok(host.includes("stringField(raw['firstMessage'])"), 'backend must normalize firstMessage');
    assert.ok(host.includes("stringField(raw['updatedAt'])"), 'backend must normalize updatedAt');
    assert.ok(host.includes("objectField(raw['_meta'])"), 'backend must normalize ACP _meta');
    assert.ok(host.includes("numberField(meta['messageCount'])"), 'backend must normalize messageCount');
    assert.ok(host.includes("numberField(meta['size'])"), 'backend must normalize size');
    assert.ok(host.includes('const stored = await this.#findStoredSession(sessionId, cwd)'), 'loadSession must find stored metadata');
    assert.ok(host.includes('if (stored?.title) info.title = stored.title'), 'loadSession must attach stored title to returned session');
});
