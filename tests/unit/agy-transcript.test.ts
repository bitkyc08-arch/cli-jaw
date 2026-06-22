import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    agyTranscriptStepKey,
    classifyAgyTranscriptRow,
    resolveAgyTranscriptPathForCurrentTurn,
    parseTranscriptLine,
    readTranscriptDelta,
    transcriptContainsPrompt,
} from '../../src/agent/agy-transcript.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '../fixtures/agy-transcript/sample-lines.jsonl');

test('AGY-TR-001: parseTranscriptLine maps RUN_COMMAND to tool entry', () => {
    const line = fs.readFileSync(fixturePath, 'utf8').split('\n')[0];
    const tool = parseTranscriptLine(line);
    assert.ok(tool);
    assert.equal(tool!.toolType, 'tool');
    assert.equal(tool!.icon, '🔧');
    assert.match(tool!.stepRef ?? '', /^agy:transcript:1:RUN_COMMAND$/);
    assert.equal(tool!.status, 'done');
});

test('AGY-TR-002: parseTranscriptLine skips PLANNER_RESPONSE process blocks', () => {
    const lines = fs.readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean);
    const tool = parseTranscriptLine(lines[2]);
    assert.equal(tool, null);
});

test('AGY-TR-006: Korean PLANNER_RESPONSE status prose is not a thinking tool', () => {
    const tool = parseTranscriptLine(JSON.stringify({
        step_index: 39,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '서버 정상! 이제 Swiss Style에 맞는 이미지 4장을 동시에 생성한다. 🦈',
    }));
    assert.equal(tool, null);
});

test('AGY-TR-003: readTranscriptDelta returns only new bytes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tr-'));
    const p = path.join(tmp, 't.jsonl');
    fs.writeFileSync(p, fs.readFileSync(fixturePath, 'utf8'));
    const first = readTranscriptDelta(p, 0);
    assert.ok(first.lines.length >= 3);
    const second = readTranscriptDelta(p, first.offset);
    assert.equal(second.lines.length, 0);
    fs.appendFileSync(p, '{"step_index":9,"type":"GREP_SEARCH","status":"DONE","content":"pattern foo"}\n');
    const third = readTranscriptDelta(p, second.offset);
    assert.equal(third.lines.length, 1);
    const tool = parseTranscriptLine(third.lines[0]);
    assert.equal(tool?.toolType, 'search');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('AGY-TR-004: agyTranscriptStepKey is stable', () => {
    assert.equal(agyTranscriptStepKey(5, 'RUN_COMMAND'), '5:RUN_COMMAND');
    assert.equal(agyTranscriptStepKey(5, 'RUN_COMMAND', 'brain-b'), 'brain-b:5:RUN_COMMAND');
});

test('AGY-TR-005: spawn wires agy transcript watcher', () => {
    const spawnSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /startAgyTranscriptWatcher/);
    assert.match(spawnSrc, /agyTranscriptWatcher\?\.stop\(\)/);
});

test('AGY-TR-007: transcript watcher retargets when AGY resume emits a new conversation id', () => {
    const watcherSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/agy-transcript-watcher.ts'), 'utf8');
    assert.match(watcherSrc, /currentSessionId\s*=\s*options\.getSessionId\(\)/);
    assert.match(watcherSrc, /currentSessionId !== conversationId/);
    assert.match(watcherSrc, /transcriptPath\s*=\s*null/);
    assert.match(watcherSrc, /conversationId\s*=\s*effectiveResolved\.conversationId/);
});

test('AGY-TR-008: transcript watcher scans current-turn lines already written before path resolution', () => {
    const watcherSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/agy-transcript-watcher.ts'), 'utf8');
    const transcriptSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/agy-transcript.ts'), 'utf8');
    assert.doesNotMatch(watcherSrc, /fs\.statSync\(transcriptPath\)\.size/);
    assert.match(watcherSrc, /offset\s*=\s*0/);
    assert.match(watcherSrc, /created_at/);
    assert.match(watcherSrc, /CURRENT_TURN_LOOKBACK_MS = 5_000/);
    assert.match(watcherSrc, /startedAt - CURRENT_TURN_LOOKBACK_MS/);
    assert.match(watcherSrc, /resolveAgyTranscriptPathForCurrentTurn/);
    assert.match(watcherSrc, /RETARGET_SCAN_MS/);
    assert.match(transcriptSrc, /export function resolveRecentAgyTranscriptPath/);
    assert.match(transcriptSrc, /stat\.mtimeMs < minMtimeMs/);
    assert.match(transcriptSrc, /transcriptContainsPrompt\(transcriptPath, prompt\)/);
    const spawnSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /prompt:\s*promptForArgs/);
});

test('AGY-TR-009: spawn captures AGY session id before final transcript drain', () => {
    const spawnSrc = fs.readFileSync(path.join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const closeIdx = spawnSrc.indexOf("child.on('close', (code) => {");
    assert.ok(closeIdx >= 0);
    const closeBlock = spawnSrc.slice(closeIdx, spawnSrc.indexOf('if (kiroPlainText)', closeIdx));
    const sessionIdx = closeBlock.indexOf('ctx.sessionId = extractAgyConversationId');
    const watcherStopIdx = closeBlock.indexOf('agyTranscriptWatcher?.stop()');
    assert.ok(sessionIdx >= 0, 'AGY close path must extract session id');
    assert.ok(watcherStopIdx > sessionIdx, 'AGY transcript final drain must run after session id extraction');
});

test('AGY-TR-011: parseTranscriptLine maps SEARCH_WEB and READ_URL_CONTENT to search tools', () => {
    const search = parseTranscriptLine(JSON.stringify({
        step_index: 12,
        source: 'MODEL',
        type: 'SEARCH_WEB',
        status: 'DONE',
        content: 'Created At: 2026-06-10T15:10:47Z\nThe search found 8 results for "claude fable 5"',
    }));
    assert.ok(search);
    assert.equal(search!.toolType, 'search');
    assert.equal(search!.icon, '🌐');
    assert.equal(search!.label, 'web search');
    assert.match(search!.stepRef ?? '', /^agy:transcript:12:SEARCH_WEB$/);
    const readUrl = parseTranscriptLine(JSON.stringify({
        step_index: 13,
        source: 'MODEL',
        type: 'READ_URL_CONTENT',
        status: 'DONE',
        content: 'https://example.com/article',
    }));
    assert.ok(readUrl);
    assert.equal(readUrl!.toolType, 'search');
    assert.equal(readUrl!.icon, '🔗');
    assert.equal(readUrl!.label, 'read url');
});

test('AGY-TR-012: parseTranscriptLine renders unknown future tool types generically', () => {
    const tool = parseTranscriptLine(JSON.stringify({
        step_index: 21,
        source: 'MODEL',
        type: 'BROWSER_ACTION',
        status: 'DONE',
        content: 'clicked element #submit',
    }));
    assert.ok(tool);
    assert.equal(tool!.label, 'browser action');
    assert.match(tool!.stepRef ?? '', /^agy:transcript:21:BROWSER_ACTION$/);
    assert.equal(parseTranscriptLine(JSON.stringify({ step_index: 22, type: 'USER_INPUT', status: 'DONE', content: 'hi' })), null);
    assert.equal(parseTranscriptLine(JSON.stringify({ step_index: 23, type: 'CHECKPOINT', status: 'DONE', content: '{{ CHECKPOINT 1 }}' })), null);
});

test('AGY-TR-013: classifyAgyTranscriptRow separates final planner rows from intermediate ones', () => {
    // Final answer: non-empty content, no tool_calls.
    assert.equal(classifyAgyTranscriptRow(JSON.stringify({
        type: 'PLANNER_RESPONSE', status: 'DONE', content: '최종 답변입니다. FINAL_SENTINEL',
    })).kind, 'final-planner');
    assert.equal(classifyAgyTranscriptRow(JSON.stringify({
        type: 'PLANNER_RESPONSE', status: 'DONE', content: 'done', tool_calls: [],
    })).kind, 'final-planner');
    // Intermediate planner: carries tool_calls.
    assert.equal(classifyAgyTranscriptRow(JSON.stringify({
        type: 'PLANNER_RESPONSE', status: 'DONE', content: '이제 파일을 읽겠습니다.',
        tool_calls: [{ name: 'view_file' }],
    })).kind, 'planner');
    // Empty-content planner without tool_calls is NOT a final answer.
    assert.equal(classifyAgyTranscriptRow(JSON.stringify({
        type: 'PLANNER_RESPONSE', status: 'DONE', content: '',
    })).kind, 'planner');
    // Meta rows and tools.
    assert.equal(classifyAgyTranscriptRow(JSON.stringify({ type: 'USER_INPUT', content: 'q' })).kind, 'meta');
    assert.equal(classifyAgyTranscriptRow(JSON.stringify({ type: 'SYSTEM_MESSAGE', content: 's' })).kind, 'meta');
    const toolRow = classifyAgyTranscriptRow(JSON.stringify({
        step_index: 5, type: 'SEARCH_WEB', status: 'DONE', content: 'results',
    }));
    assert.equal(toolRow.kind, 'tool');
    assert.equal(toolRow.tool?.icon, '🌐');
    // Garbage lines.
    assert.equal(classifyAgyTranscriptRow('not json').kind, 'invalid');
    assert.equal(classifyAgyTranscriptRow('').kind, 'invalid');
    assert.equal(classifyAgyTranscriptRow('{"content":"no type"}').kind, 'invalid');
});

test('AGY-TR-017: ERROR_MESSAGE is provider error evidence, not a transcript tool', () => {
    const line = JSON.stringify({
        type: 'ERROR_MESSAGE',
        error: 'The model is currently unreachable.',
        error_code: 503,
        created_at: '2026-06-22T04:00:00.000Z',
    });
    const row = classifyAgyTranscriptRow(line);
    assert.equal(row.kind, 'provider-error');
    assert.equal(row.error?.message, 'The model is currently unreachable.');
    assert.equal(row.error?.code, 503);
    assert.equal(row.error?.createdAtMs, Date.parse('2026-06-22T04:00:00.000Z'));
    assert.equal(parseTranscriptLine(line), null);
});

test('AGY-TR-018: malformed ERROR_MESSAGE rows classify safely', () => {
    const row = classifyAgyTranscriptRow(JSON.stringify({
        type: 'ERROR_MESSAGE',
        error_code: { nested: true },
        created_at: 'not-a-date',
    }));
    assert.equal(row.kind, 'provider-error');
    assert.equal(row.error?.message, 'Antigravity provider error');
    assert.equal(row.error?.code, undefined);
    assert.equal(row.error?.createdAtMs, undefined);
});

test('AGY-TR-014: transcriptContainsPrompt matches JSON-escaped multiline prompts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tr14-'));
    const p = path.join(tmp, 'transcript.jsonl');
    const prompt = '[Current cli-jaw task]\n260611-12:59AM.\n반드시 웹 검색 도구(search_web)를 사용해서 "Anthropic Claude 최신 모델"을 검색해. 검색 시작 전에 진행 상황을 말해.';
    fs.writeFileSync(p, JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>`,
    }) + '\n');
    // Raw JSONL stores the prompt with \n and \" escapes — must still match.
    assert.equal(transcriptContainsPrompt(p, prompt), true);
    assert.equal(transcriptContainsPrompt(p, '완전히 다른 프롬프트입니다. 이 내용은 transcript 어디에도 존재하지 않는 문장이어야 합니다.'), false);
    fs.rmSync(tmp, { recursive: true, force: true });
});

function writeBrainTranscript(
    brainRoot: string,
    conversationId: string,
    rows: Array<Record<string, unknown>>,
    mtimeMs: number,
): string {
    const transcriptPath = path.join(
        brainRoot,
        conversationId,
        '.system_generated',
        'logs',
        'transcript.jsonl',
    );
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const mtime = new Date(mtimeMs);
    fs.utimesSync(transcriptPath, mtime, mtime);
    return transcriptPath;
}

test('AGY-TR-015: current-turn resolver prefers fresh prompt-matching brain over stale saved session', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tr15-'));
    const brainRoot = path.join(tmp, 'brain');
    const startedAt = Date.now();
    const prompt = '현재 실행의 고유 프롬프트입니다. stale saved transcript 대신 fresh brain B를 선택해야 합니다.';
    const staleA = writeBrainTranscript(brainRoot, 'conversation-a', [{
        step_index: 0,
        type: 'USER_INPUT',
        content: '이전 실행 프롬프트',
    }], startedAt - 60_000);
    const freshB = writeBrainTranscript(brainRoot, 'conversation-b', [{
        step_index: 0,
        type: 'USER_INPUT',
        content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>`,
    }], startedAt + 1_000);

    const resolved = resolveAgyTranscriptPathForCurrentTurn(
        tmp,
        'conversation-a',
        startedAt - 5_000,
        prompt,
        { brainRoot },
    );

    assert.equal(resolved.ok, true);
    assert.equal(resolved.conversationId, 'conversation-b');
    assert.equal(resolved.transcriptPath, freshB);
    assert.notEqual(resolved.transcriptPath, staleA);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('AGY-TR-016: current-turn resolver waits instead of selecting stale saved transcript', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tr16-'));
    const brainRoot = path.join(tmp, 'brain');
    const startedAt = Date.now();
    const prompt = '현재 실행 프롬프트가 아직 brain에 기록되지 않은 상태입니다.';
    writeBrainTranscript(brainRoot, 'conversation-a', [{
        step_index: 0,
        type: 'USER_INPUT',
        content: '오래된 다른 프롬프트',
    }], startedAt - 60_000);

    const resolved = resolveAgyTranscriptPathForCurrentTurn(
        tmp,
        'conversation-a',
        startedAt - 5_000,
        prompt,
        { brainRoot },
    );

    assert.equal(resolved.ok, false);
    assert.equal(resolved.conversationId, 'conversation-a');
    assert.equal(resolved.transcriptPath, undefined);
    assert.match(resolved.reason ?? '', /not current-turn/);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('AGY-TR-010: parseTranscriptLine maps CODE_ACTION write_to_file completion to tool entry', () => {
    const tool = parseTranscriptLine(JSON.stringify({
        step_index: 8,
        source: 'AGENT',
        type: 'CODE_ACTION',
        status: 'DONE',
        content: 'Created file file:///tmp/agy-3474-complex-smoke/style.css',
    }));
    assert.ok(tool);
    assert.equal(tool!.toolType, 'tool');
    assert.equal(tool!.icon, '📝');
    assert.equal(tool!.status, 'done');
    assert.match(tool!.stepRef ?? '', /^agy:transcript:8:CODE_ACTION$/);
    assert.match(tool!.detail, /style\.css/);
});
