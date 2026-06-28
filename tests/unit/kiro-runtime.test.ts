import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { buildArgs, buildResumeArgs } from '../../src/agent/args.ts';
import { listKiroConversationIdsForCwd, resolveKiroDataPath } from '../../src/agent/kiro-auth.ts';
import {
    appendKiroStdoutChunk,
    captureKiroSessionIdAfterExit,
    extractKiroSessionIdFromStore,
    finalizeKiroFullText,
    flushKiroStdoutContext,
    isKiroPlainTextCli,
    isKiroResumeDegradedOutput,
    isKiroStaleSessionOutput,
    parseKiroAssistantText,
    parseKiroSessionIdFromStdout,
    parseAiESessionIdFromStderr,
    processKiroStdoutChunk,
    resolveKiroSessionIdAfterSpawn,
    stripKiroAnsi,
} from '../../src/agent/kiro-runtime.ts';

test('kiro buildArgs uses chat --no-interactive with trust-all-tools in auto mode', () => {
    const args = buildArgs('kiro-code', 'auto', '', 'hello', '', 'auto');
    assert.deepEqual(args.slice(0, 4), ['chat', '--no-interactive', '--trust-all-tools', '--model']);
    assert.equal(args[4], 'auto');
    assert.equal(args[5], 'hello');
});

test('kiro buildArgs omits trust-all-tools in safe mode', () => {
    const args = buildArgs('kiro-code', 'claude-sonnet-4.6', '', 'hello', '', 'safe');
    assert.deepEqual(args, ['chat', '--no-interactive', '--model', 'claude-sonnet-4.6', 'hello']);
});

test('kiro buildResumeArgs uses --resume-id', () => {
    const args = buildResumeArgs('kiro-code', 'auto', '', 'sess-123', 'follow up', 'auto');
    assert.deepEqual(args.slice(0, 5), ['chat', '--no-interactive', '--resume-id', 'sess-123', '--trust-all-tools']);
    assert.equal(args.at(-1), 'follow up');
});

test('parseKiroAssistantText strips ANSI and extracts > response lines', () => {
    const raw = '\x1b[32mAll tools are now trusted\x1b[0m\n\n\x1b[m> kiro-smoke-ok\x1b[0m\n\x1b[m\n ▸ Credits: 0.04 • Time: 2s\n';
    assert.equal(parseKiroAssistantText(raw), 'kiro-smoke-ok');
    assert.equal(stripKiroAnsi(raw).includes('\x1b'), false);
});

test('appendKiroStdoutChunk emits only assistant deltas', () => {
    const ctx = { fullText: '', kiroDisplayedText: '' };
    const delta1 = appendKiroStdoutChunk(ctx, '\x1b[m> hel');
    assert.equal(delta1, 'hel');
    const delta2 = appendKiroStdoutChunk(ctx, 'lo\n');
    assert.equal(delta2, 'lo');
    const delta3 = appendKiroStdoutChunk(ctx, '\n▸ Credits: 0.04');
    assert.equal(delta3, '');
    assert.equal(finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer), 'hello');
});

test('processKiroStdoutChunk emits tool start and done events from shell output', () => {
    const ctx = { fullText: '', kiroDisplayedText: '' };
    const shellChunk = [
        'All tools are now trusted (!).',
        'I will run the following command: echo kiro-tool-smoke-test (using tool: shell)',
        'kiro-tool-smoke-test',
        ' - Completed in 0.22s',
        '',
        '> done',
    ].join('\n');

    const events = processKiroStdoutChunk(ctx, shellChunk);
    assert.deepEqual(
        events.map((event) => event.kind === 'tool'
            ? { kind: event.kind, label: event.label, status: event.status, icon: event.icon }
            : event),
        [
            { kind: 'tool', label: 'shell: echo kiro-tool-smoke-test', status: 'running', icon: '💻' },
            { kind: 'tool', label: 'shell: echo kiro-tool-smoke-test', status: 'done', icon: '✅' },
            { kind: 'assistant_delta', text: 'done' },
        ],
    );
});

test('processKiroStdoutChunk strips ANSI before accumulating fullText', () => {
    const ctx = { fullText: '', kiroDisplayedText: '' };
    processKiroStdoutChunk(ctx, '\x1b[32m> clean response\x1b[0m\n');
    assert.equal(ctx.fullText.includes('\x1b'), false);
    assert.equal(finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer), 'clean response');
});

test('processKiroStdoutChunk emits read tool events', () => {
    const ctx = { fullText: '', kiroDisplayedText: '' };
    const readChunk = [
        'Reading file: /etc/hosts, from line 1 to 1 (using tool: read)',
        '✓ Successfully read 2 bytes from /etc/hosts',
        '- Completed in 0.0s',
        '> Done.',
    ].join('\n');

    const events = processKiroStdoutChunk(ctx, readChunk);
    assert.equal(events.filter((event) => event.kind === 'tool').length, 3);
    assert.equal(events.at(-1)?.kind, 'assistant_delta');
    assert.equal(finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer), 'Done.');
});

test('processKiroStdoutChunk does not stream read result text as assistant output across chunks', () => {
    const ctx = { fullText: '', kiroDisplayedText: '' };
    const first = processKiroStdoutChunk(ctx, [
        '> 확인 후 답변하겠습니다.',
        'Reading file: /tmp/secret.txt, from line 1 to 2 (using tool: read)',
    ].join('\n') + '\n');
    const leaked = processKiroStdoutChunk(ctx, [
        'SECRET_LINE_1',
        'SECRET_LINE_2',
        '✓ Successfully read 26 bytes from /tmp/secret.txt',
        '- Completed in 0.0s',
        '> 완료했습니다.',
    ].join('\n') + '\n');

    const deltas = [...first, ...leaked]
        .filter((event) => event.kind === 'assistant_delta')
        .map((event) => event.text)
        .join('');
    const finalText = finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer);
    assert.equal(deltas.includes('SECRET_LINE'), false);
    assert.equal(ctx.fullText.includes('SECRET_LINE'), false);
    assert.equal(finalText.includes('SECRET_LINE'), false);
    assert.equal(finalText, '확인 후 답변하겠습니다.\n\n완료했습니다.');
});

test('parseKiroAssistantText captures continuation lines after > lead', () => {
    const raw = [
        'I will run the following command: pwd (using tool: shell)',
        '/Users/jun',
        '- Completed in 0.1s',
        '> Here are the full results from all 10 tool calls.',
        '1. pwd → /Users/jun',
        '2. ls → ok',
        '▸ Credits: 0.1 • Time: 5s',
    ].join('\n');
    assert.equal(
        parseKiroAssistantText(raw),
        'Here are the full results from all 10 tool calls.\n1. pwd → /Users/jun\n2. ls → ok',
    );
});

test('processKiroStdoutChunk streams continuation lines after > without waiting for close', () => {
    const ctx = { fullText: '', kiroDisplayedText: '' };
    processKiroStdoutChunk(ctx, '> Done — all 10 tool calls ran.\n');
    const events = processKiroStdoutChunk(ctx, '1. pwd → /Users/jun\n2. ls → ok\n');
    const deltas = events.filter((event) => event.kind === 'assistant_delta').map((event) => event.text).join('');
    assert.match(deltas, /1\. pwd/);
    assert.match(deltas, /2\. ls → ok/);
    assert.equal(
        finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer),
        'Done — all 10 tool calls ran.\n1. pwd → /Users/jun\n2. ls → ok',
    );
});

test('processKiroStdoutChunk splits parallel tool starts on one physical line', () => {
    const ctx = { fullText: '', kiroDisplayedText: '' };
    const merged = 'Reading file: /etc/hosts, from line 1 to 1 (using tool: read)I will run the following command: echo one (using tool: shell)';
    const events = processKiroStdoutChunk(ctx, `${merged}\n`);
    const running = events.filter((event) => event.kind === 'tool' && event.status === 'running');
    assert.equal(running.length, 2);
    assert.match(running[0]?.label || '', /read/i);
    assert.match(running[1]?.label || '', /shell: echo one/);
});

test('flushKiroStdoutContext appends buffered continuation line without trailing newline', () => {
    const ctx = { fullText: '', kiroDisplayedText: '', kiroLineBuffer: '' };
    processKiroStdoutChunk(ctx, '> 1. hosts: ##\n');
    ctx.kiroLineBuffer = '2. echo: kiro-final';
    const tail = flushKiroStdoutContext(ctx);
    const deltas = tail.filter((event) => event.kind === 'assistant_delta').map((event) => event.text).join('');
    assert.match(deltas, /2\. echo: kiro-final/);
    assert.equal(
        finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer),
        '1. hosts: ##\n2. echo: kiro-final',
    );
});

test('parseKiroAssistantText keeps markdown sections after blank lines in one block', () => {
    const raw = [
        '> # cli-jaw stdout routing',
        '',
        '## Overview',
        '',
        'Paragraph one with details.',
        '',
        '## Checklist',
        '1. first',
        '2. second',
    ].join('\n');
    const parsed = parseKiroAssistantText(raw);
    assert.match(parsed, /stdout routing/);
    assert.match(parsed, /## Overview/);
    assert.match(parsed, /Paragraph one/);
    assert.match(parsed, /## Checklist/);
    assert.match(parsed, /2\. second/);
    assert.ok(parsed.length > 80);
});

test('processKiroStdoutChunk streams long markdown body incrementally', () => {
    const ctx = { fullText: '', kiroDisplayedText: '' };
    processKiroStdoutChunk(ctx, '> #### 한 줄 전제\n\n');
    const events = processKiroStdoutChunk(ctx, '## 본문\n\n긴 설명 텍스트입니다.\n\n');
    const deltas = events.filter((e) => e.kind === 'assistant_delta').map((e) => e.text).join('');
    assert.match(deltas, /본문/);
    assert.match(finalizeKiroFullText(ctx.fullText, ctx.kiroLineBuffer), /긴 설명/);
});

test('extractKiroSessionIdFromStore picks newest matching cwd session', () => {
    const homedir = fs.mkdtempSync(join(os.tmpdir(), 'kiro-runtime-'));
    const dataPath = resolveKiroDataPath(homedir);
    fs.mkdirSync(dirname(dataPath), { recursive: true });
    const db = new Database(dataPath);
    db.exec(`CREATE TABLE conversations_v2 (
        key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, conversation_id)
    );`);
    const cwd = '/tmp/kiro-test-cwd';
    const insert = db.prepare(
        'INSERT INTO conversations_v2 (key, conversation_id, value, created_at, updated_at) VALUES (?,?,?,?,?)',
    );
    insert.run(cwd, 'old-session', '{}', 0, Date.parse('2026-05-30T10:00:00.000Z'));
    insert.run(cwd, 'new-session', '{}', 0, Date.parse('2026-05-30T12:00:00.000Z'));
    db.close();

    assert.equal(
        extractKiroSessionIdFromStore(cwd, Date.parse('2026-05-30T11:00:00.000Z'), homedir),
        'new-session',
    );
    assert.equal(extractKiroSessionIdFromStore('/other', 0, homedir), null);
});

test('resolveKiroSessionIdAfterSpawn prefers set-diff over latest row', () => {
    const homedir = fs.mkdtempSync(join(os.tmpdir(), 'kiro-runtime-'));
    const dataPath = resolveKiroDataPath(homedir);
    fs.mkdirSync(dirname(dataPath), { recursive: true });
    const db = new Database(dataPath);
    db.exec(`CREATE TABLE conversations_v2 (
        key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (key, conversation_id)
    );`);
    const cwd = '/tmp/kiro-diff-cwd';
    const insert = db.prepare(
        'INSERT INTO conversations_v2 (key, conversation_id, value, created_at, updated_at) VALUES (?,?,?,?,?)',
    );
    insert.run(cwd, 'stale-latest', '{}', 0, Date.parse('2026-05-31T12:00:00.000Z'));
    insert.run(cwd, 'older-existing', '{}', 0, Date.parse('2026-05-31T10:00:00.000Z'));
    const before = listKiroConversationIdsForCwd(cwd, dataPath);
    assert.deepEqual([...before].sort(), ['older-existing', 'stale-latest']);
    insert.run(cwd, 'brand-new', '{}', 0, Date.parse('2026-05-31T11:00:00.000Z'));
    db.close();

    const resolved = resolveKiroSessionIdAfterSpawn(cwd, before, 0, dataPath);
    assert.equal(resolved, 'brand-new');
});

test('parseAiESessionIdFromStderr reads ai-e session footer', () => {
    const raw = 'ai-e: kiro provider timed out\n[ai-e] session: 79eee8a5-7c00-4cd9-8385-c534a2f8b814\n[ai-e] resume: ai-e kiro --resume 79eee8a5-7c00-4cd9-8385-c534a2f8b814 "next"';
    assert.equal(parseAiESessionIdFromStderr(raw), '79eee8a5-7c00-4cd9-8385-c534a2f8b814');
});

test('isKiroPlainTextCli includes ai-e kiro provider', () => {
    assert.equal(isKiroPlainTextCli('kiro-code'), true);
    assert.equal(isKiroPlainTextCli('ai-e', 'kiro'), true);
    assert.equal(isKiroPlainTextCli('ai-e', 'codex'), false);
});

test('parseKiroSessionIdFromStdout reads TUI session hint lines', () => {
    const raw = '● Session ID: 24b53e9c-e117-479e-8d9e-191688be7dd5\nResume with: kiro-cli --resume-id 24b53e9c-e117-479e-8d9e-191688be7dd5';
    assert.equal(parseKiroSessionIdFromStdout(raw), '24b53e9c-e117-479e-8d9e-191688be7dd5');
    assert.equal(parseKiroSessionIdFromStdout('> OK\n'), null);
});

test('isKiroStaleSessionOutput detects no-saved-sessions and not-found phrases', () => {
    assert.equal(isKiroStaleSessionOutput('No saved chat sessions for this directory.'), true);
    assert.equal(isKiroStaleSessionOutput('> all good\n'), false);
    assert.equal(isKiroResumeDegradedOutput('', 0, true), true);
    assert.equal(isKiroResumeDegradedOutput('hello', 0, true), false);
    assert.equal(isKiroResumeDegradedOutput('', 0, false), false);

    const carry = captureKiroSessionIdAfterExit({
        cwd: '/tmp',
        spawnStartedAt: 0,
        beforeIds: null,
        stdout: '',
        stderr: '',
        resumeSessionId: 'abc-123',
        isResume: true,
    });
    assert.deepEqual(carry, { id: 'abc-123', source: 'resume-carry' });
});
