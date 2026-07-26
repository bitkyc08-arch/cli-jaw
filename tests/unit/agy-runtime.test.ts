import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    AGY_COMPLETE_KILL_REASON,
    AGY_FALLBACK_QUIET_COMPLETION_MS,
    AGY_FULLTEXT_MAX_CHARS,
    AGY_FULLTEXT_TRUNCATION_NOTICE,
    AGY_LIVE_DISPLAY_MAX_CHARS,
    AGY_PRINT_QUIET_COMPLETION_MS,
    appendAgyFullText,
    describeAgyFinalSource,
    extractAgyConversationId,
    finalizeAgyFallbackText,
    AGY_PLANNER_ONLY_NOTICE,
    formatAgyTimeoutMessage,
    formatAgyTranscriptErrorMessage,
    formatAgyWatchdogContext,
    getAgyQuietCompletionDelayMs,
    hasRunningAgyTranscriptTool,
    isAgyTimeoutOutput,
    normalizeAgyCloseText,
    resolveAgyEmptyCloseError,
    shouldCompleteAgyPrintRun,
    shouldFreezeAgyLiveDisplay,
    stripAgyPromptEchoPrefix,
    stripAgyResumeReplayPrefix,
    stripAgyResumeReplayPrefixes,
    stripAgyTrailingTimeoutOutput,
} from '../../src/agent/agy-runtime.ts';
import { resolveSpawnOutputText } from '../../src/agent/events/helpers.ts';

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

test('AGY-RT-002b: formats unresolved AGY transcript provider errors', () => {
    assert.equal(
        formatAgyTranscriptErrorMessage({ message: 'The model is currently unreachable.', code: 503 }),
        'Antigravity backend unavailable (503): The model is currently unreachable.',
    );
    assert.equal(
        resolveAgyEmptyCloseError({
            fullText: '',
            liveOutputText: '',
            agyLastTranscriptError: { message: 'The model is currently unreachable.', code: 503 },
        }),
        'Antigravity backend unavailable (503): The model is currently unreachable.',
    );
    assert.equal(
        resolveAgyEmptyCloseError({
            fullText: 'final answer',
            liveOutputText: '',
            agyLastTranscriptError: { message: 'transient', code: 503 },
        }),
        null,
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
    assert.match(spawnSrc, /agyTranscriptErrorMessage[\s\S]*resolveAgyEmptyCloseError\(ctx\)/);
    assert.match(spawnSrc, /effectiveExitCode\s*=\s*agyCompletedByQuietOutput && !agyTranscriptErrorMessage[\s\S]*\?\s*0[\s\S]*agyTimedOut\s*\?\s*124[\s\S]*ctx\.stallReason\s*\?\s*124[\s\S]*code/);
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
    assert.match(spawnSrc, /appendAgyFullText\(ctx,\s*text\)/);
    const agyStdoutStart = spawnSrc.indexOf('const rawText = agyUtf8!.write(chunk)');
    assert.ok(agyStdoutStart >= 0, 'AGY stdout decoder block must exist');
    const agyStdoutBlock = spawnSrc.slice(
        agyStdoutStart,
        spawnSrc.indexOf("if (kiroPlainText) {", agyStdoutStart),
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

test('AGY-RT-008b: AGY and Kiro raw stdout/stderr activity marks watchdog progress', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const agyStdoutStart = spawnSrc.indexOf('const rawText = agyUtf8!.write(chunk)');
    assert.ok(agyStdoutStart >= 0, 'AGY stdout decoder block must exist');
    const agyStdoutBlock = spawnSrc.slice(
        agyStdoutStart,
        spawnSrc.indexOf("if (kiroPlainText) {", agyStdoutStart),
    );
    assert.match(agyStdoutBlock, /const rawText = agyUtf8!\.write\(chunk\);/);
    assert.match(agyStdoutBlock, /if \(!rawText\) return;\s*ctx\.stallWatchdog\?\.markProgress\(\);/);

    const kiroStdoutStart = spawnSrc.indexOf("if (kiroPlainText) {");
    assert.ok(kiroStdoutStart >= 0, 'Kiro stdout block must exist');
    const kiroStdoutBlock = spawnSrc.slice(
        kiroStdoutStart,
        spawnSrc.indexOf('buffer += chunk.toString();', kiroStdoutStart),
    );
    assert.match(kiroStdoutBlock, /const text = kiroUtf8!\.write\(chunk\);/);
    assert.match(kiroStdoutBlock, /if \(!text\) return;\s*ctx\.stallWatchdog\?\.markProgress\(\);/);
    assert.match(kiroStdoutBlock, /appendTraceEvent\(\{[\s\S]*raw:\s*text/);

    const stderrStart = spawnSrc.indexOf("child.stderr.on('data'");
    assert.ok(stderrStart >= 0, 'stderr handler must exist');
    const stderrBlock = spawnSrc.slice(
        stderrStart,
        spawnSrc.indexOf("child.on('close'", stderrStart),
    );
    assert.match(stderrBlock, /if \(\(kiroPlainText \|\| cli === 'agy'\) && text\) ctx\.stallWatchdog\?\.markProgress\(\);/);
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
    assert.match(spawnSrc, /effectiveExitCode\s*=\s*agyCompletedByQuietOutput && !agyTranscriptErrorMessage[\s\S]*\?\s*0/);
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
    // The boundary strings moved from spawn.ts into the shared prompt-context module.
    const contextSrc = readFileSync(join(__dirname, '../../src/agent/prompt-context.ts'), 'utf8');
    assert.match(contextSrc, /Recent Context is read-only background/);
    assert.match(contextSrc, /Do not continue prior plans, audits, commands, questions, or goals/);
    assert.match(contextSrc, /\[Current Message\]/);
});

test('AGY-RT-012d: AGY prompt path uses bootstrap envelope after final spawn cwd', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /buildAgyBootstrapEnvelope/);
    assert.match(spawnSrc, /let agyBootstrap: AgyBootstrapEnvelope \| null = null/);
    assert.doesNotMatch(spawnSrc, /cli === 'agy' \|\| cli === 'cursor'/);
    const agyBootstrapBlock = spawnSrc.slice(
        spawnSrc.indexOf("if (cli === 'agy') {"),
        spawnSrc.indexOf('// ─── DIFF-A: Preflight', spawnSrc.indexOf("if (cli === 'agy') {")),
    );
    assert.match(agyBootstrapBlock, /buildAgyBootstrapEnvelope\(\{/);
    assert.match(agyBootstrapBlock, /taskPrompt:\s*prompt/);
    assert.match(agyBootstrapBlock, /workingDir:\s*spawnCwd/);
    assert.match(agyBootstrapBlock, /promptForArgs\s*=\s*agyBootstrap\.prompt/);
    assert.match(agyBootstrapBlock, /argOptions\s*=\s*\{\s*\.\.\.argOptions,\s*workingDir:\s*spawnCwd\s*\}/);
    assert.match(agyBootstrapBlock, /args\s*=\s*buildCurrentArgs\(argOptions\)/);
});

test('AGY-RT-012e: AGY prompt spill metadata is attached safely after bootstrap exists', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const ctxIdx = spawnSrc.indexOf('const ctx: SpawnContext = {');
    const lifecycleIdx = spawnSrc.indexOf('let agyClosing', ctxIdx);
    assert.ok(ctxIdx >= 0);
    const ctxBlock = spawnSrc.slice(ctxIdx, lifecycleIdx);
    assert.match(ctxBlock, /metadata:\s*\{\s*agyPromptSpill:\s*agyBootstrap\.spill\s*\}/);
    assert.match(ctxBlock, /agyBootstrapSentinel:\s*agyBootstrap\.sentinel/);
    assert.doesNotMatch(ctxBlock, /agyBootstrap\.prompt/);
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
        agyBootstrapAccepted: false,
        agyBootstrapAcceptanceMode: 'missing',
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
    assert.match(watcherSrc, /agyLastTranscriptError = error/);
    assert.match(watcherSrc, /agyLastTranscriptError = undefined/);
    assert.match(watcherSrc, /kind === 'provider-error'/);
    // Fast-resume regression: a USER_INPUT row must clear a stale final-planner flag set
    // by the previous turn's row inside the lookback buffer.
    assert.match(watcherSrc, /rowType === 'USER_INPUT'/);
});

test('AGY-RT-016: AGY unresolved transcript provider error is finalized before smoke and lifecycle', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const helperIdx = spawnSrc.indexOf('resolveAgyEmptyCloseError(ctx)');
    const exitCodeIdx = spawnSrc.indexOf('const effectiveExitCode =', helperIdx);
    const smokeIdx = spawnSrc.indexOf('detectSmokeResponse(ctx.fullText', helperIdx);
    const lifecycleIdx = spawnSrc.indexOf('handleAgentExit({', helperIdx);
    assert.ok(helperIdx >= 0, 'spawn must resolve unresolved AGY transcript errors');
    assert.ok(exitCodeIdx > helperIdx, 'effective exit code must use transcript error result');
    assert.ok(smokeIdx > exitCodeIdx, 'smoke detection must see the provider-error exit code');
    assert.ok(lifecycleIdx > smokeIdx, 'lifecycle must run after provider-error finalization');
    assert.match(spawnSrc, /agyTranscriptErrorMessage[\s\S]*\?\s*1/);
    assert.match(spawnSrc, /ctx\.fullText\s*=\s*''/);
    assert.match(spawnSrc, /ctx\.liveOutputText\s*=\s*''/);
    assert.match(spawnSrc, /appendTraceEvent\(\{[\s\S]*eventType:\s*'runtime_error'[\s\S]*agyTranscriptErrorMessage/);
});

<<<<<<< Updated upstream
test('AGY-RT-017: appendAgyFullText accumulates past the old 102,400 silent cap', () => {
    const ctx = { fullText: '', agyFullTextTruncated: undefined as boolean | undefined };
    const chunk = 'x'.repeat(60_000);
    appendAgyFullText(ctx, chunk);
    appendAgyFullText(ctx, chunk);
    assert.equal(ctx.fullText.length, 120_000, 'must keep the full 120 KB (old cap silently stopped at 102,400)');
    assert.equal(ctx.agyFullTextTruncated, undefined);
});

test('AGY-RT-018: appendAgyFullText slices at AGY_FULLTEXT_MAX_CHARS, flags, then no-ops', () => {
    const ctx = { fullText: 'y'.repeat(AGY_FULLTEXT_MAX_CHARS - 10), agyFullTextTruncated: undefined as boolean | undefined };
    appendAgyFullText(ctx, 'z'.repeat(100));
    assert.equal(ctx.fullText.length, AGY_FULLTEXT_MAX_CHARS);
    assert.equal(ctx.agyFullTextTruncated, true);
    appendAgyFullText(ctx, 'more');
    assert.equal(ctx.fullText.length, AGY_FULLTEXT_MAX_CHARS, 'appends after the flag must be no-ops');
});

test('AGY-RT-019: live display freeze requires visible output first (quiet completion stays eligible)', () => {
    const oversized = 'a'.repeat(AGY_LIVE_DISPLAY_MAX_CHARS + 1);
    assert.equal(
        shouldFreezeAgyLiveDisplay({ outputTextStarted: false, fullText: oversized }),
        false,
        'first oversized chunk must still run the display path so outputTextStarted gets set',
    );
    assert.equal(shouldFreezeAgyLiveDisplay({ outputTextStarted: true, fullText: oversized }), true);
    assert.equal(shouldFreezeAgyLiveDisplay({ outputTextStarted: true, fullText: 'short' }), false);
});

test('AGY-RT-020: finalizeAgyFallbackText promotes the full body past a frozen live candidate', () => {
    const fullBody = `intro\n${'b'.repeat(300_000)}\nfinal conclusion`;
    const ctx = {
        fullText: fullBody,
        liveOutputText: fullBody.slice(0, 1_000),
        agyFinalPlannerSeen: undefined as boolean | undefined,
        agyFullTextTruncated: undefined as boolean | undefined,
    };
    assert.equal(finalizeAgyFallbackText(ctx, fullBody), true);
    assert.equal(ctx.liveOutputText, fullBody);
    // End-to-end: the agent_done resolver prefers display candidates; the promoted
    // live candidate must deliver the full body (regression: frozen 1 KB masked it).
    assert.equal(resolveSpawnOutputText(ctx), fullBody.trim());
});

test('AGY-RT-021: finalizeAgyFallbackText appends the truncation notice to both candidates', () => {
    const ctx = {
        fullText: 'body',
        liveOutputText: 'body',
        agyFinalPlannerSeen: undefined as boolean | undefined,
        agyFullTextTruncated: true,
    };
    assert.equal(finalizeAgyFallbackText(ctx, 'body'), true);
    assert.ok(ctx.fullText.endsWith(AGY_FULLTEXT_TRUNCATION_NOTICE));
    assert.ok(ctx.liveOutputText.endsWith(AGY_FULLTEXT_TRUNCATION_NOTICE));

    const noLive = {
        fullText: 'body',
        liveOutputText: undefined as string | undefined,
        agyFinalPlannerSeen: undefined as boolean | undefined,
        agyFullTextTruncated: true,
    };
    assert.equal(finalizeAgyFallbackText(noLive, 'body'), true);
    assert.ok(noLive.fullText.endsWith(AGY_FULLTEXT_TRUNCATION_NOTICE));
    assert.equal(noLive.liveOutputText, undefined);

    // agy initializes liveOutputText to '' (spawn.ts) — distinct from undefined: the
    // empty string is a live candidate, so it gets promoted first and then noticed.
    const emptyLive = {
        fullText: 'body',
        liveOutputText: '' as string | undefined,
        agyFinalPlannerSeen: undefined as boolean | undefined,
        agyFullTextTruncated: true,
    };
    assert.equal(finalizeAgyFallbackText(emptyLive, 'body'), true);
    assert.equal(emptyLive.liveOutputText, `body${AGY_FULLTEXT_TRUNCATION_NOTICE}`);
    assert.ok(emptyLive.fullText.endsWith(AGY_FULLTEXT_TRUNCATION_NOTICE));
});

test('AGY-RT-022: finalizeAgyFallbackText no-ops for transcript-anchored or untouched runs', () => {
    const planner = {
        fullText: 'planner final',
        liveOutputText: 'short',
        agyFinalPlannerSeen: true,
        agyFullTextTruncated: true,
    };
    assert.equal(finalizeAgyFallbackText(planner, 'anything longer than short'), false);
    assert.equal(planner.liveOutputText, 'short');
    assert.equal(planner.fullText, 'planner final');

    const untouched = {
        fullText: 'same',
        liveOutputText: 'same body already longer',
        agyFinalPlannerSeen: undefined as boolean | undefined,
        agyFullTextTruncated: undefined as boolean | undefined,
    };
    assert.equal(finalizeAgyFallbackText(untouched, 'same'), false);
});

test('AGY-RT-023: stdout fallback with an intermediate planner prefix is withheld', () => {
    const ctx = {
        fullText: 'my_tool_call_analysis: inspect state',
        liveOutputText: 'my_tool_call_analysis: inspect',
        agyFinalPlannerSeen: false,
        metadata: {},
    };
    assert.equal(finalizeAgyFallbackText(ctx, ctx.fullText), true);
    assert.equal(ctx.fullText, AGY_PLANNER_ONLY_NOTICE);
    assert.equal(ctx.liveOutputText, AGY_PLANNER_ONLY_NOTICE);
    assert.equal(ctx.metadata.agyPlannerOnly, true);
});

test('AGY-RT-023: describeAgyFinalSource reports mode and truncation for diagnosability', () => {
    assert.equal(
        describeAgyFinalSource({ agyFinalPlannerSeen: true, agyFinalPlannerText: 'x', agyFullTextTruncated: undefined, fullText: 'x' }),
        '[jaw:agy:final] source=transcript chars=1 truncated=0',
    );
    assert.equal(
        describeAgyFinalSource({ agyFinalPlannerSeen: undefined, agyFinalPlannerText: undefined, agyFullTextTruncated: true, fullText: 'abc' }),
        '[jaw:agy:final] source=stdout-fallback chars=3 truncated=1',
    );
||||||| Stash base
=======
test('AGY-RT-017: spawn wires AGY transcript mode and watchdog context', () => {
    const spawnSrc = readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /classifyAgyTranscriptMode/);
    assert.match(spawnSrc, /formatAgyWatchdogContext/);
    assert.match(spawnSrc, /agyTranscriptMode:\s*'not-started'/);
    assert.match(spawnSrc, /agyLastActivitySource:\s*'none'/);
    assert.match(spawnSrc, /ctx\.agyLastActivitySource = 'stdout'/);
    assert.match(spawnSrc, /if \(cli === 'agy'\) ctx\.agyLastActivitySource = 'stderr'/);
    assert.match(spawnSrc, /ctx\.agyTranscriptMode = classifyAgyTranscriptMode\(ctx\)/);
    assert.match(spawnSrc, /const agyWatchdogContext = formatAgyWatchdogContext\(ctx\)/);
    assert.match(spawnSrc, /pushTrace\(ctx, agyWatchdogContext\)/);

    const context = formatAgyWatchdogContext({
        stallReason: 'first progress timeout',
        agyTranscriptMode: 'fallback-missing',
        agyLastActivitySource: 'stdout',
        sessionId: null,
        toolLog: [{ icon: '🔧', label: 'run command', toolType: 'tool', status: 'running' }],
    });
    assert.match(context, /transcriptMode=fallback-missing/);
    assert.match(context, /lastActivity=stdout/);
    assert.match(context, /lastTool=run command status=running/);
>>>>>>> Stashed changes
});
