import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    AGY_COMPLETE_KILL_REASON,
    AGY_FALLBACK_QUIET_COMPLETION_MS,
    AGY_PRINT_QUIET_COMPLETION_MS,
    extractAgyConversationId,
    formatAgyTimeoutMessage,
    getAgyQuietCompletionDelayMs,
    hasRunningAgyTranscriptTool,
    isAgyTimeoutOutput,
    normalizeAgyCloseText,
    shouldCompleteAgyPrintRun,
    stripAgyPromptEchoPrefix,
    stripAgyResumeReplayPrefix,
    stripAgyResumeReplayPrefixes,
    stripAgyTrailingTimeoutOutput,
} from '../../src/agent/agy-runtime.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('AGY-RT-001: detects AGY timeout text even when exit code is zero', () => {
    assert.equal(isAgyTimeoutOutput('Error: timed out waiting for response\n'), true);
    assert.equal(isAgyTimeoutOutput('\nError: timed out waiting for response'), true);
    assert.equal(isAgyTimeoutOutput('normal answer'), false);
});

test('AGY-RT-002: formats empty timeout output defensively', () => {
    assert.equal(formatAgyTimeoutMessage(''), 'Error: timed out waiting for response');
    assert.equal(
        formatAgyTimeoutMessage(' Error: timed out waiting for response '),
        'Error: timed out waiting for response',
    );
});

test('AGY-RT-003: extracts exact native AGY conversation ids from resume hints', () => {
    assert.equal(
        extractAgyConversationId('Resume with: agy --conversation=6f9d4d6b-d0ee-4bfd-adb7-6cc2a74a10c2'),
        '6f9d4d6b-d0ee-4bfd-adb7-6cc2a74a10c2',
    );
    assert.equal(
        extractAgyConversationId('Resume: agy --conversation 6F9D4D6B-D0EE-4BFD-ADB7-6CC2A74A10C2 (or -c)'),
        '6F9D4D6B-D0EE-4BFD-ADB7-6CC2A74A10C2',
    );
    assert.equal(
        extractAgyConversationId('I0521 printmode.go:130] Print mode: conversation=e001ab02-a833-413e-9e8c-6deef90330c1, sending message'),
        'e001ab02-a833-413e-9e8c-6deef90330c1',
    );
    assert.equal(
        extractAgyConversationId('I0521 server.go:747] Created conversation e001ab02-a833-413e-9e8c-6deef90330c1'),
        'e001ab02-a833-413e-9e8c-6deef90330c1',
    );
    assert.equal(extractAgyConversationId('Resume: agy -c'), null);
});

test('AGY-RT-004: AGY timeout stdout is routed to lifecycle as an error', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /normalizeAgyCloseText\(\{[\s\S]*allowTimeoutSuffixStrip:\s*Boolean\(ctx\.agyFinalPlannerSeen\)/);
    assert.match(spawnSrc, /const agyTimedOut\s*=\s*cli === 'agy' && agyCloseTimedOut/);
    assert.match(spawnSrc, /effectiveExitCode\s*=\s*agyCompletedByQuietOutput\s*\?\s*0\s*:\s*agyTimedOut\s*\?\s*124\s*:\s*ctx\.stallReason\s*\?\s*124\s*:\s*code/);
    assert.match(spawnSrc, /ctx\.stderrBuf\s*=/);
    assert.match(spawnSrc, /ctx\.fullText\s*=\s*''/);
    assert.match(spawnSrc, /detectSmokeResponse\(ctx\.fullText,\s*ctx\.toolLog,\s*effectiveExitCode,\s*cli\)/);
    assert.match(spawnSrc, /handleAgentExit\(\{[\s\S]*code:\s*effectiveExitCode/);
});

test('AGY-RT-005: AGY stdout conversation id is persisted for native resume', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /extractAgyConversationId\(ctx\.fullText\)/);
    assert.match(spawnSrc, /if\s*\(!ctx\.sessionId\)\s*ctx\.sessionId\s*=\s*extractAgyConversationId\(ctx\.fullText\)/);
});

test('AGY-RT-006: AGY print-mode log file is used when stdout omits resume hints', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const argsSrc = readFileSync(join(__dirname, '../../src/agent/args.ts'), 'utf8');
    assert.match(spawnSrc, /agyLogFile/);
    assert.match(argsSrc, /'--log-file'/);
    assert.match(spawnSrc, /fs\.readFileSync\(agyLogFile,\s*'utf8'\)/);
    assert.match(spawnSrc, /fs\.rmSync\(agyLogFile,\s*\{\s*force:\s*true\s*\}\)/);
});

test('AGY-RT-007: AGY stdout strips ANSI before persistence and sanitized trace append', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /rawText\s*=\s*agyUtf8!\.write\(chunk\)/);
    assert.match(spawnSrc, /rawText\.replace\(\/\\x1B/);
    assert.match(spawnSrc, /ctx\.fullText\s*\+=\s*text/);
    const agyStdoutBlock = spawnSrc.slice(
        spawnSrc.indexOf("if (cli === 'agy') {"),
        spawnSrc.indexOf("if (kiroPlainText) {"),
    );
    assert.doesNotMatch(agyStdoutBlock, /appendTraceEvent\(\{[\s\S]*raw:\s*text/);
    assert.match(agyStdoutBlock, /appendTraceEvent\(\{[\s\S]*raw:\s*displayText/);
});

test('AGY-RT-008: AGY print timeout is a hard cap while cli-jaw watchdog owns progress timeout', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const timeoutBlock = spawnSrc.slice(
        spawnSrc.indexOf("const rawTimeoutCfg = (settings as Record<string, unknown>)['agentTimeout'];"),
        spawnSrc.indexOf('const argOptions = {'),
    );
    const watchdogBlock = spawnSrc.slice(
        spawnSrc.indexOf('const rawAgentTimeoutCfg = (settings as Record<string, unknown>)["agentTimeout"];'),
        spawnSrc.indexOf('const stallWatchdog = attachWatchdog'),
    );

    assert.match(timeoutBlock, /absoluteHardCapMs/);
    assert.match(timeoutBlock, /DEFAULT_WATCHDOG_ABSOLUTE_HARD_CAP_MS/);
    assert.match(timeoutBlock, /formatAgyPrintTimeout\(resolvedAgyPrintTimeoutMs\)/);
    assert.doesNotMatch(timeoutBlock, /absoluteMs[\s\S]*formatAgyPrintTimeout/);
    assert.match(watchdogBlock, /absoluteHardCapMs/);
    assert.match(spawnSrc, /startAgyTranscriptWatcher\(\{[\s\S]*ctx,/);
});

test('AGY-RT-009: AGY print runs can finish after quiet assistant output', () => {
    assert.equal(shouldCompleteAgyPrintRun({
        outputTextStarted: true,
        liveOutputText: 'done',
        fullText: 'done',
        toolLog: [],
    }), true);
    assert.equal(shouldCompleteAgyPrintRun({
        outputTextStarted: true,
        liveOutputText: 'done',
        fullText: 'done',
        toolLog: [{ icon: '🔧', label: 'cmd', toolType: 'tool', stepRef: 'agy:transcript:1:RUN_COMMAND', status: 'running' }],
    }), false);
    assert.equal(hasRunningAgyTranscriptTool([
        { stepRef: 'agy:transcript:1:RUN_COMMAND', status: 'done' },
    ]), false);
    assert.equal(shouldCompleteAgyPrintRun({
        outputTextStarted: true,
        liveOutputText: 'Error: timed out waiting for response',
        fullText: 'Error: timed out waiting for response',
        toolLog: [],
    }), false);
});

test('AGY-RT-010: AGY quiet completion is mapped to lifecycle success, not interruption', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, new RegExp(`stdKillReason === ['"]${AGY_COMPLETE_KILL_REASON}['"]|stdKillReason === AGY_COMPLETE_KILL_REASON`));
    assert.match(spawnSrc, /wasKilled\s*=\s*!!stdKillReason\s*&&\s*!agyCompletedByQuietOutput/);
    assert.match(spawnSrc, /effectiveExitCode\s*=\s*agyCompletedByQuietOutput\s*\?\s*0\s*:/);
    assert.match(spawnSrc, /getAgyQuietCompletionDelayMs\(ctx\)/);
});

test('AGY-RT-011: AGY timeout suffix is stripped without masking timeout-only output', () => {
    assert.deepEqual(
        stripAgyTrailingTimeoutOutput('JAW_AGY_DONE\nError: timed out waiting for response\n'),
        { text: 'JAW_AGY_DONE', stripped: true },
    );
    assert.deepEqual(
        stripAgyTrailingTimeoutOutput('Error: timed out waiting for response\n'),
        { text: 'Error: timed out waiting for response\n', stripped: false },
    );
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /normalizeAgyCloseText\(\{/);
});

test('AGY-RT-011b: AGY progress plus native timeout is not saved as completion without final planner', () => {
    const progressThenTimeout = '순번 확인부터 합니다.\nError: timed out waiting for response\n';
    assert.deepEqual(
        normalizeAgyCloseText({
            fullText: progressThenTimeout,
            liveOutputText: progressThenTimeout,
            allowTimeoutSuffixStrip: false,
        }),
        {
            text: progressThenTimeout,
            liveText: progressThenTimeout,
            timedOut: true,
            timeoutMessage: 'Error: timed out waiting for response',
            strippedTimeout: false,
        },
    );

    assert.deepEqual(
        normalizeAgyCloseText({
            fullText: '최종 답변입니다.\nError: timed out waiting for response\n',
            liveOutputText: '최종 답변입니다.\nError: timed out waiting for response\n',
            allowTimeoutSuffixStrip: true,
        }),
        {
            text: '최종 답변입니다.',
            liveText: '최종 답변입니다.',
            timedOut: false,
            timeoutMessage: '',
            strippedTimeout: true,
        },
    );

    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /normalizeAgyCloseText\(\{/);
    assert.doesNotMatch(spawnSrc, /stripAgyTrailingTimeoutOutput\(ctx\.fullText\)[\s\S]{0,400}const agyTimedOut/);
});

test('AGY-RT-012: AGY resume does not trim current stdout by prior output length', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const start = spawnSrc.indexOf('Length-based replay trimming can therefore swallow the whole new answer.');
    const end = spawnSrc.indexOf('const ctx: SpawnContext =', start);
    const resumeOffsetBlock = start >= 0 && end > start ? spawnSrc.slice(start, end) : '';
    assert.match(resumeOffsetBlock, /const agyResumeOffset = 0/);
    assert.doesNotMatch(resumeOffsetBlock, /bucketRow\?\.output_len|employeeOutputLen/);
});

test('AGY-RT-012b: AGY uses cli-jaw history instead of native resume', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /const providerSupportsResume\s*=\s*cli !== 'agy'/);
    assert.match(spawnSrc, /const needsHistory\s*=\s*!opts\._skipHistory && \(!isResume \|\| cli === 'pi'\)/);
});

test('AGY-RT-012c: history injection treats prior context as read-only background', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /Recent Context is read-only background/);
    assert.match(spawnSrc, /Do not continue prior plans, audits, commands, questions, or goals/);
    assert.match(spawnSrc, /\[Current Message\]/);
});

test('AGY-RT-013: AGY resume replay prefix is stripped only when new output remains', () => {
    assert.deepEqual(
        stripAgyResumeReplayPrefix('OLD_ANSWER\nNEW_ANSWER', 'OLD_ANSWER'),
        { text: 'NEW_ANSWER', stripped: true },
    );
    assert.deepEqual(
        stripAgyResumeReplayPrefix('OLD_ANSWER', 'OLD_ANSWER'),
        { text: 'OLD_ANSWER', stripped: false },
    );
    assert.deepEqual(
        stripAgyResumeReplayPrefix('NEW_ANSWER', 'OLD_ANSWER'),
        { text: 'NEW_ANSWER', stripped: false },
    );
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /getLatestAssistantContentForAgyResume/);
    assert.match(spawnSrc, /stripAgyResumeReplayPrefix\(ctx\.fullText,\s*agyResumeReplayPrefix\)/);
});

test('AGY-RT-013b: AGY resume strips multi-turn replay before live quiet completion', () => {
    assert.deepEqual(
        stripAgyResumeReplayPrefixes('OLD_0\nOLD_1\nNEW_2', ['OLD_1', 'OLD_0']),
        { text: 'NEW_2', stripped: true, replayOnly: false },
    );
    assert.deepEqual(
        stripAgyResumeReplayPrefixes('OLD_0\nOLD_1', ['OLD_1', 'OLD_0']),
        { text: '', stripped: true, replayOnly: true },
    );
    assert.deepEqual(
        stripAgyResumeReplayPrefixes('NEW_2', ['OLD_1', 'OLD_0']),
        { text: 'NEW_2', stripped: false, replayOnly: false },
    );
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /getRecentAssistantContentsForAgyResume/);
    assert.match(spawnSrc, /stripAgyResumeReplayPrefixes\(ctx\.fullText,\s*agyResumeReplayPrefixes\)/);
    assert.match(spawnSrc, /ctx\.liveOutputText\s*=\s*displayFullText/);
    assert.match(spawnSrc, /ctx\.outputTextStarted\s*=\s*Boolean\(displayFullText\.trim\(\)\)/);
    assert.match(spawnSrc, /ctx\.agyFinalPlannerSeen && ctx\.agyFinalPlannerText/);
    assert.match(spawnSrc, /ctx\.fullText\s*=\s*ctx\.agyFinalPlannerText/);
});

test('AGY-RT-013c: AGY prompt echo strips history/current task prefix from live and final output', () => {
    const prompt = [
        '[Current cli-jaw task]',
        '[Recent Context]',
        '[user] old request',
        '',
        '---',
        '[Current Message]',
        '260611-12:02PM.',
        'agy 히스토리 블록도 다시 누출되고 있어 이것도 감사해봐',
        '',
        '---',
        '',
        '[Operational Context — cli-jaw Integration]',
        'Follow the runtime rules.',
    ].join('\n');
    assert.deepEqual(
        stripAgyPromptEchoPrefix(`${prompt}\n\n실제 답변입니다.`, prompt),
        { text: '실제 답변입니다.', stripped: true, replayOnly: false },
    );
    assert.deepEqual(
        stripAgyPromptEchoPrefix(`${prompt}\n`, prompt),
        { text: '', stripped: true, replayOnly: true },
    );
    assert.deepEqual(
        stripAgyPromptEchoPrefix('실제 답변입니다.', prompt),
        { text: '실제 답변입니다.', stripped: false, replayOnly: false },
    );

    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /stripAgyPromptEchoPrefix\(visibleFullText,\s*promptForArgs\)/);
    assert.match(spawnSrc, /stripAgyPromptEchoPrefix\(ctx\.fullText,\s*promptForArgs\)/);
    assert.match(spawnSrc, /stripAgyPromptEchoPrefix\(ctx\.liveOutputText,\s*promptForArgs\)/);
});

test('AGY-RT-014: AGY quiet completion is anchored on the final transcript planner row', () => {
    const interimProgress = '이전 턴에서 리서치가 다 끝났어요. 바로 쓰레드를 작성하고 저장할게요.';
    // Transcript active but final planner not seen: never complete, regardless of text shape.
    assert.equal(getAgyQuietCompletionDelayMs({
        outputTextStarted: true,
        liveOutputText: interimProgress,
        fullText: interimProgress,
        toolLog: [],
        agyTranscriptActive: true,
        agyFinalPlannerSeen: false,
    }), null);
    // Transcript active + final planner row seen: complete after the short safety window.
    assert.equal(getAgyQuietCompletionDelayMs({
        outputTextStarted: true,
        liveOutputText: '최종 답변입니다.\nFINAL_SENTINEL',
        fullText: '최종 답변입니다.\nFINAL_SENTINEL',
        toolLog: [],
        agyTranscriptActive: true,
        agyFinalPlannerSeen: true,
    }), AGY_PRINT_QUIET_COMPLETION_MS);
    // Final planner seen but a transcript tool still running: blocked.
    assert.equal(getAgyQuietCompletionDelayMs({
        outputTextStarted: true,
        liveOutputText: 'partial',
        fullText: 'partial',
        toolLog: [{ icon: '🔧', label: 'cmd', toolType: 'tool', stepRef: 'agy:transcript:1:RUN_COMMAND', status: 'running' }],
        agyTranscriptActive: true,
        agyFinalPlannerSeen: true,
    }), null);
    // Transcript never resolved: legacy stdout-quiet fallback with a wide window.
    assert.equal(getAgyQuietCompletionDelayMs({
        outputTextStarted: true,
        liveOutputText: 'answer without transcript',
        fullText: 'answer without transcript',
        toolLog: [],
    }), AGY_FALLBACK_QUIET_COMPLETION_MS);
    // Timeout-only output stays an error in both modes.
    assert.equal(getAgyQuietCompletionDelayMs({
        outputTextStarted: true,
        liveOutputText: 'Error: timed out waiting for response',
        fullText: 'Error: timed out waiting for response',
        toolLog: [],
        agyTranscriptActive: true,
        agyFinalPlannerSeen: true,
    }), null);
    // No visible output yet: never complete.
    assert.equal(getAgyQuietCompletionDelayMs({
        outputTextStarted: false,
        liveOutputText: '',
        fullText: '',
        toolLog: [],
        agyTranscriptActive: true,
        agyFinalPlannerSeen: true,
    }), null);
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /getAgyQuietCompletionDelayMs\(ctx\)/);
    assert.match(spawnSrc, /onActivity:\s*\(\)\s*=>\s*\{[\s\S]*?scheduleAgyQuietCompletion\(\);\s*\}/);
});

test('AGY-RT-015: transcript watcher drives the final planner flag and growth activity', () => {
    const watcherSrc = readFileSync(join(__dirname, '../../src/agent/agy-transcript-watcher.ts'), 'utf8');
    assert.match(watcherSrc, /const minCreatedAtMs = startedAt - CURRENT_TURN_LOOKBACK_MS/);
    assert.match(watcherSrc, /updateFinalPlannerFlag\(options\.ctx, line, minCreatedAtMs\)/);
    assert.match(watcherSrc, /agyFinalPlannerSeen = true/);
    assert.match(watcherSrc, /agyFinalPlannerSeen = false/);
    assert.match(watcherSrc, /agyFinalPlannerText = rowContent/);
    assert.match(watcherSrc, /agyFinalPlannerText = undefined/);
    assert.match(watcherSrc, /delta\.offset > previousOffset/);
    assert.match(watcherSrc, /agyTranscriptActive = true/);
    assert.match(watcherSrc, /options\.onActivity\?\.\(\)/);
    // Fast-resume regression: a USER_INPUT row must clear a stale final-planner flag set
    // by the previous turn's row inside the lookback buffer.
    assert.match(watcherSrc, /rowType === 'USER_INPUT'/);
});
