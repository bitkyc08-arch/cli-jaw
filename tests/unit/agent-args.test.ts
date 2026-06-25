// Phase 9.4: agent argument builder 단위 테스트
// 이미 export된 함수를 직접 검증 (추가 작업 없이 즉시 실행 가능)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatAgyPrintTimeout, resolveAgyAddDirectories, resolveGeminiIncludeDirectories } from '../../src/agent/args.ts';
import { buildAiERuntimeStatusMeta, buildArgs, buildResumeArgs, resolveAiEProvider, resolveSessionBucket, shouldResumeBucketSession } from '../../src/agent/spawn.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── buildArgs: claude ───────────────────────────────

test('AG-001: claude default excludes --model', () => {
    const args = buildArgs('claude', 'default', '', 'hello', '', 'auto');
    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--output-format'));
    assert.ok(!args.includes('--model'));
});

test('AG-000a: agy uses print p-mode with timeout, permissions, and add-dir roots', () => {
    const args = buildArgs('agy', 'gemini-3.5-flash', '', 'hi', '', 'auto', {
        workingDir: '/repo',
        homedir: '/home/jun',
        includeDirectories: ['/extra'],
    });
    assert.deepEqual(args, [
        '-p', 'hi',
        '--model', 'gemini-3.5-flash',
        '--print-timeout', '10m',
        '--dangerously-skip-permissions',
        '--add-dir', '/repo',
        '--add-dir', '/extra',
    ]);
});

test('AG-000b: agy safe permissions omit dangerous skip flag', () => {
    const args = buildArgs('agy', 'gemini-3.5-flash', '', 'hi', '', 'safe', {
        workingDir: '/repo',
        homedir: '/home/jun',
    });
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('--print-timeout'));
});

test('AG-000c: agy passes --model but never unsupported output/include-directory flags', () => {
    const args = buildArgs('agy', 'gemini-3.5-flash', 'high', 'hi', '', 'auto', {
        workingDir: '/repo',
        includeDirectories: ['/extra'],
    });
    assert.ok(args.includes('--model'));
    assert.ok(!args.includes('--output-format'));
    assert.ok(!args.includes('--include-directories'));
});

test('AG-000d: agy add-dir roots dedupe without implicit home directory', () => {
    assert.deepEqual(resolveAgyAddDirectories({
        workingDir: '/repo/',
        homedir: '/home/jun',
        includeDirectories: ['/repo', '/extra', '/extra/'],
    }), ['/repo', '/extra']);
});

test('AG-000e: agy resume uses exact native conversation id with print mode', () => {
    const args = buildResumeArgs('agy', 'gemini-3.5-flash', '', 'sess-1', 'hi', 'auto', {
        workingDir: '/repo',
        homedir: '/home/jun',
    });
    assert.deepEqual(args.slice(0, 8), ['--conversation', 'sess-1', '-p', 'hi', '--model', 'gemini-3.5-flash', '--print-timeout', '10m']);
    assert.ok(!args.includes('--resume'));
    assert.ok(!args.includes('--continue'));
    assert.ok(args.includes('--conversation'));
    assert.ok(args.includes('--model'));
    assert.ok(!args.includes('--output-format'));
});

test('AG-000f: agy supports per-run log file capture for print-mode session ids', () => {
    const freshArgs = buildArgs('agy', 'gemini-3.5-flash', '', 'hi', '', 'auto', {
        agyLogFile: '/tmp/jaw-agy-test.log',
    });
    assert.deepEqual(freshArgs.slice(4, 8), ['--print-timeout', '10m', '--log-file', '/tmp/jaw-agy-test.log']);

    const resumeArgs = buildResumeArgs('agy', 'gemini-3.5-flash', '', 'sess-1', 'hi', 'auto', {
        agyLogFile: '/tmp/jaw-agy-test.log',
    });
    assert.ok(resumeArgs.includes('--conversation'));
    assert.ok(resumeArgs.includes('--log-file'));
    assert.ok(resumeArgs.includes('/tmp/jaw-agy-test.log'));
});

test('AG-000g: agy print-timeout formatter rounds milliseconds up to minute duration', () => {
    assert.equal(formatAgyPrintTimeout(600_000), '10m');
    assert.equal(formatAgyPrintTimeout(4 * 60 * 60_000), '240m');
    assert.equal(formatAgyPrintTimeout(600_001), '11m');
});

test('AG-002: claude custom model includes --model', () => {
    const args = buildArgs('claude', 'opus-4', '', 'hello', '', 'auto');
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('opus-4'));
});

test('AG-003: claude auto permission includes skip-permissions', () => {
    const args = buildArgs('claude', 'default', '', 'hi', '', 'auto');
    assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('AG-004: claude non-auto permission excludes skip-permissions', () => {
    const args = buildArgs('claude', 'default', '', 'hi', '', 'safe');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('AG-005: claude with system prompt includes --append-system-prompt', () => {
    const args = buildArgs('claude', 'default', '', 'hi', 'system instructions', 'auto');
    assert.ok(args.includes('--append-system-prompt'));
    assert.ok(args.includes('system instructions'));
});

test('AG-006: claude with effort includes --effort', () => {
    const args = buildArgs('claude', 'default', 'high', 'hi', '', 'auto');
    assert.ok(args.includes('--effort'));
    assert.ok(args.includes('high'));
});

test('AG-006a: claude-e forwards system prompt through wrapper extra args', () => {
    const args = buildArgs('claude-e', 'sonnet', 'high', 'hi', 'system instructions', 'auto');
    const separatorIdx = args.indexOf('--');
    assert.ok(separatorIdx >= 0, 'claude-e must use -- before forwarded Claude args');
    const forwarded = args.slice(separatorIdx + 1);
    assert.ok(forwarded.includes('--append-system-prompt'));
    assert.ok(forwarded.includes('system instructions'));
});

test('AG-006b: claude-e auto permissions auto-accept workspace trust in wrapper', () => {
    const args = buildArgs('claude-e', 'sonnet', 'medium', 'hi', '', 'auto');
    assert.ok(args.includes('--auto-accept-workspace-trust'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('AG-006c: claude-e resume auto permissions auto-accept workspace trust in wrapper', () => {
    const args = buildResumeArgs('claude-e', 'sonnet', 'medium', 'sess-1', 'hi', 'auto');
    assert.ok(args.includes('--auto-accept-workspace-trust'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
});

test('AG-006d: ai-e claude routes through explicit provider-first PTY args', () => {
    const args = buildArgs('ai-e', 'sonnet', 'high', 'hi', 'system instructions', 'auto', { aiEProvider: 'claude' });
    assert.deepEqual(args.slice(0, 2), ['claude', 'run']);
    assert.ok(args.includes('--idle-timeout-ms'));
    assert.ok(args.includes('--hard-timeout-ms'));
    assert.ok(args.includes('--claude-bin') === false);
    const separatorIdx = args.indexOf('--');
    assert.ok(separatorIdx >= 0);
    const forwarded = args.slice(separatorIdx + 1);
    assert.ok(forwarded.includes('--model'));
    assert.ok(forwarded.includes('sonnet'));
    assert.ok(forwarded.includes('--append-system-prompt'));
});

test('AG-006e: ai-e codex routes through interactive mode with timeout', () => {
    const args = buildArgs('ai-e', 'gpt-5.4', 'high', 'hi', '', 'auto', { aiEProvider: 'codex' });
    assert.equal(args[0], 'codex');
    assert.ok(args.includes('--timeout-ms'));
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('gpt-5.4'));
    assert.ok(!args.includes('--idle-timeout-ms'));
    assert.ok(!args.includes('p'));
    assert.equal(args.at(-1), 'hi');
});

test('AG-006f: ai-e copilot explicit provider wins over gpt model inference', () => {
    const args = buildArgs('ai-e', 'gpt-5-mini', 'medium', 'hi', '', 'auto', { aiEProvider: 'copilot' });
    assert.equal(args[0], 'copilot');
    assert.ok(!args.includes('p'));
    assert.equal(resolveAiEProvider('copilot', 'gpt-5-mini'), 'copilot');
    assert.equal(resolveAiEProvider(undefined, 'gpt-5-mini'), 'codex');
});

test('AG-006g: ai-e resume injects resume flag for claude, codex, grok, and kiro', () => {
    const claudeArgs = buildResumeArgs('ai-e', 'sonnet', 'medium', 'sess-1', 'hi', 'auto', { aiEProvider: 'claude' });
    assert.deepEqual(claudeArgs.slice(0, 2), ['claude', 'run']);
    assert.ok(claudeArgs.includes('--resume'));
    const codexArgs = buildResumeArgs('ai-e', 'gpt-5.4', 'medium', 'sess-1', 'hi', 'auto', { aiEProvider: 'codex' });
    assert.equal(codexArgs[0], 'codex');
    assert.ok(codexArgs.includes('--resume'));
    assert.ok(codexArgs.includes('sess-1'));
    const kiroArgs = buildResumeArgs(
        'ai-e',
        'auto',
        'medium',
        '79eee8a5-7c00-4cd9-8385-c534a2f8b814',
        'follow up',
        'auto',
        { aiEProvider: 'kiro' },
    );
    assert.deepEqual(kiroArgs.slice(0, 2), ['kiro', 'p']);
    assert.ok(kiroArgs.includes('--resume'));
    assert.ok(kiroArgs.includes('79eee8a5-7c00-4cd9-8385-c534a2f8b814'));
    assert.equal(kiroArgs.at(-1), 'follow up');
});

test('AG-006g-kiro: ai-e kiro uses text output and auto provider inference', () => {
    const args = buildArgs('ai-e', 'auto', 'medium', 'hi', '', 'auto', { aiEProvider: 'kiro' });
    assert.deepEqual(args.slice(0, 2), ['kiro', 'p']);
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('text'));
    assert.equal(resolveAiEProvider('kiro', 'auto'), 'kiro');
    assert.equal(resolveAiEProvider(undefined, 'deepseek-3.2'), 'kiro');
});

test('AG-006g2: ai-e non-Claude providers use p-mode argv prompt and never include AGY', () => {
    const cases = [
        ['codex', 'gpt-5.4'],
        ['gemini', 'gemini-3.1-flash'],
        ['grok', 'grok-4'],
        ['copilot', 'gpt-5-mini'],
        ['kiro', 'auto'],
    ] as const;
    for (const [provider, model] of cases) {
        const args = buildArgs('ai-e', model, 'medium', `prompt-${provider}`, '', 'auto', { aiEProvider: provider });
        assert.equal(args[0], provider);
        if (provider === 'kiro') {
            assert.equal(args[1], 'p');
        } else {
            assert.equal(args[1], '--output-format');
        }
        assert.equal(args.at(-1), `prompt-${provider}`);
        assert.ok(!args.includes('run'));
        assert.ok(!args.includes('agy'));
        assert.ok(!args.includes('antigravity'));
    }
    assert.equal(resolveAiEProvider('agy', 'default'), 'claude');
    assert.equal(resolveAiEProvider('antigravity', 'default'), 'claude');
});

test('AG-006h: ai-e spawn resolves provider before Claude model normalization', () => {
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    assert.match(spawnSrc, /resolveAiEProvider\([\s\S]*cfg\.provider[\s\S]*ao\.provider[\s\S]*requestedModel/);
    assert.match(spawnSrc, /effectiveProvider\s*===\s*'claude'[\s\S]*migrateLegacyClaudeValue\(requestedModel\)/);
});

test('AG-006h2: ai-e spawn prefers perCli provider over stale active override provider', () => {
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const providerBlock = spawnSrc.match(/const effectiveProvider = cli === 'ai-e'[\s\S]*?\n        : cli;/)?.[0] || '';
    assert.match(providerBlock, /typeof cfg\.provider === 'string'/);
    assert.match(providerBlock, /typeof ao\.provider === 'string'/);
    assert.ok(
        providerBlock.indexOf("typeof cfg.provider === 'string'") < providerBlock.indexOf("typeof ao.provider === 'string'"),
        'perCli provider must override stale activeOverrides provider',
    );
});

test('AG-006i: ai-e non-Claude PTY prompt providers support resume for codex/grok/kiro', () => {
    const spawnSrc = fs.readFileSync(join(__dirname, '../../src/agent/spawn.ts'), 'utf8');
    const resumeSupportBlock = spawnSrc.match(/const providerSupportsResume =[\s\S]*?;/)?.[0] || '';
    assert.match(resumeSupportBlock, /cli !== 'agy'/);
    assert.match(resumeSupportBlock, /effectiveProvider !== 'claude'/);
    assert.match(resumeSupportBlock, /effectiveProvider !== 'kiro'/);
    assert.match(resumeSupportBlock, /effectiveProvider !== 'codex'/);
    assert.match(resumeSupportBlock, /effectiveProvider !== 'grok'/);
    assert.match(spawnSrc, /providerSupportsResume\s*&&\s*!\s*opts\._skipResume/);
});

test('AG-006j: ai-e runtime status metadata exposes provider and mode', () => {
    assert.deepEqual(buildAiERuntimeStatusMeta('claude-e', 'claude', 'sonnet'), {});

    const claudeMeta = buildAiERuntimeStatusMeta('ai-e', 'claude', 'sonnet');
    assert.equal(claudeMeta.selector, 'ai-e');
    assert.equal(claudeMeta.provider, 'claude');
    assert.equal(claudeMeta.mode, 'pty');
    assert.deepEqual(claudeMeta.runtime, {
        cli: 'ai-e',
        selector: 'ai-e',
        provider: 'claude',
        model: 'sonnet',
        mode: 'pty',
    });

    const codexMeta = buildAiERuntimeStatusMeta('ai-e', 'codex', 'gpt-5.4');
    assert.equal(codexMeta.provider, 'codex');
    assert.equal(codexMeta.mode, 'pty');
});

// ─── buildArgs: codex ────────────────────────────────

test('AG-007: codex auto includes bypass flag', () => {
    const args = buildArgs('codex', 'o3', 'high', 'build it', '', 'auto');
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(args.includes('exec'));
});

test('AG-008: codex safe excludes bypass flag', () => {
    const args = buildArgs('codex', 'o3', '', 'build it', '', 'safe');
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('AG-009: codex includes --json', () => {
    const args = buildArgs('codex', 'default', '', 'x', '', 'auto');
    assert.ok(args.includes('--json'));
});

test('AG-009b: codex forces model_reasoning_summary="detailed" so UI receives reasoning items', () => {
    const args = buildArgs('codex', 'default', '', 'x', '', 'auto');
    const cIdxs = args.reduce<number[]>((acc, v, i) => (v === '-c' ? [...acc, i] : acc), []);
    const cVals = cIdxs.map(i => args[i + 1]);
    assert.ok(cVals.includes('model_reasoning_summary="detailed"'), 'must inject reasoning summary override');
    assert.ok(cVals.includes('hide_agent_reasoning=false'), 'must keep reasoning visible');
    assert.ok(cVals.includes('show_raw_agent_reasoning=true'), 'must request raw reasoning when available');
});

test('AG-009c: codex resume also injects reasoning summary override', () => {
    const args = buildResumeArgs('codex', 'default', '', 'sess-xyz', 'continue', 'auto');
    const cIdxs = args.reduce<number[]>((acc, v, i) => (v === '-c' ? [...acc, i] : acc), []);
    const cVals = cIdxs.map(i => args[i + 1]);
    assert.ok(cVals.includes('model_reasoning_summary="detailed"'), 'resume must also force detailed');
    assert.ok(cVals.includes('show_raw_agent_reasoning=true'), 'resume must also request raw reasoning');
});

test('AG-009d: codex Spark model strips ALL reasoning config (effort + summary + hide)', () => {
    const args = buildArgs('codex', 'gpt-5.3-spark', 'high', 'x', '', 'auto');
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(!cVals.some(v => v.includes('model_reasoning_effort')), 'spark must drop model_reasoning_effort');
    assert.ok(!cVals.some(v => v.includes('model_reasoning_summary')), 'spark must drop model_reasoning_summary');
    assert.ok(!cVals.some(v => v.includes('hide_agent_reasoning')), 'spark must drop hide_agent_reasoning');
    assert.ok(!cVals.some(v => v.includes('show_raw_agent_reasoning')), 'spark must drop raw reasoning flag');
    assert.ok(args.includes('gpt-5.3-spark'), 'model arg still present');
});

test('AG-009g: codex Spark model pins context_window=128k + auto_compact_limit=110k', () => {
    const args = buildArgs('codex', 'gpt-5.3-codex-spark', 'high', 'x', '', 'auto');
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(cVals.includes('model_context_window=128000'), 'spark must pin 230k context window');
    assert.ok(cVals.includes('model_auto_compact_token_limit=110000'), 'spark must pin 200k auto-compact threshold');
});

test('AG-009h: non-spark codex does NOT pin context_window / auto_compact (let user config decide)', () => {
    const args = buildArgs('codex', 'gpt-5.4', 'high', 'x', '', 'auto');
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(!cVals.some(v => v.includes('model_context_window')), 'non-spark must not override context_window');
    assert.ok(!cVals.some(v => v.includes('model_auto_compact_token_limit')), 'non-spark must not override compact limit');
});

test('AG-009i: codex Spark resume also pins context_window + auto_compact', () => {
    const args = buildResumeArgs('codex', 'gpt-5.3-codex-spark', 'high', 'sess-xyz', 'continue', 'auto');
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(cVals.includes('model_context_window=128000'));
    assert.ok(cVals.includes('model_auto_compact_token_limit=110000'));
});

// ─── resolveSessionBucket: spark gets its own bucket ───

test('AG-009j: resolveSessionBucket — codex + spark model → codex-spark bucket', () => {
    assert.equal(resolveSessionBucket('codex', 'gpt-5.3-codex-spark'), 'codex-spark');
    assert.equal(resolveSessionBucket('codex', 'GPT-5-Spark'), 'codex-spark');
    assert.equal(resolveSessionBucket('codex', 'codex-spark-mini'), 'codex-spark');
});

test('AG-009j2: resolveSessionBucket — ai-e buckets include explicit provider', () => {
    assert.equal(resolveSessionBucket('ai-e', 'sonnet', 'claude'), 'ai-e:claude');
    assert.equal(resolveSessionBucket('ai-e', 'gpt-5-mini', 'copilot'), 'ai-e:copilot');
    assert.equal(resolveSessionBucket('ai-e', 'gpt-5-mini'), 'ai-e:codex');
});

test('AG-009k: resolveSessionBucket — non-spark codex stays in codex bucket', () => {
    assert.equal(resolveSessionBucket('codex', 'gpt-5.4'), 'codex');
    assert.equal(resolveSessionBucket('codex', 'gpt-5.3-codex'), 'codex');
    assert.equal(resolveSessionBucket('codex', 'default'), 'codex');
    assert.equal(resolveSessionBucket('codex', ''), 'codex');
});

test('AG-009l: resolveSessionBucket — non-codex CLI returns cli unchanged', () => {
    assert.equal(resolveSessionBucket('claude', 'sonnet-spark-fake'), 'claude', 'spark check is codex-scoped');
    assert.equal(resolveSessionBucket('gemini', 'gemini-3-flash'), 'gemini');
    assert.equal(resolveSessionBucket('grok', 'grok-build'), 'grok');
    assert.equal(resolveSessionBucket('pi', 'grok-composer-2.5-fast'), 'pi');
    assert.equal(resolveSessionBucket('opencode', 'anything'), 'opencode');
});

test('AG-009m: resolveSessionBucket — null/undefined cli returns empty string', () => {
    assert.equal(resolveSessionBucket(null, 'gpt-5.4'), '');
    assert.equal(resolveSessionBucket(undefined, 'gpt-5.4'), '');
    assert.equal(resolveSessionBucket('', null), '');
});

test('AG-009n: shouldResumeBucketSession — Copilot mismatch forces fresh session', () => {
    assert.equal(shouldResumeBucketSession('copilot', 'claude-opus-4.7', 'claude-opus-4.6'), false);
});

test('AG-009o: shouldResumeBucketSession — Copilot match still resumes', () => {
    assert.equal(shouldResumeBucketSession('copilot', 'claude-opus-4.6', 'claude-opus-4.6'), true);
});

test('AG-009p: shouldResumeBucketSession — Copilot normalizes deprecated fast alias before compare', () => {
    assert.equal(shouldResumeBucketSession('copilot', 'claude-opus-4.6', 'claude-opus-4.6-fast'), true);
});

test('AG-009q: shouldResumeBucketSession — non-Copilot/non-OpenCode/non-Gemini CLIs keep current resume behavior', () => {
    assert.equal(shouldResumeBucketSession('claude', 'claude-opus-4-6', 'claude-sonnet-4-6'), true);
});

test('AG-009q2: shouldResumeBucketSession — Gemini resumes only matching fresh concrete model buckets', () => {
    const now = Date.parse('2026-05-08T00:00:00Z');
    assert.equal(shouldResumeBucketSession('gemini', 'gemini-2.5-pro', 'gemini-2.5-pro', null, null, now, now), true);
    assert.equal(shouldResumeBucketSession('gemini', 'gemini-2.5-pro', 'gemini-2.5-flash', null, null, now, now), false);
    assert.equal(shouldResumeBucketSession('gemini', 'default', 'gemini-2.5-pro', null, null, now, now), false);
    assert.equal(shouldResumeBucketSession('gemini', 'default', 'default', null, null, now, now), false);
});

test('AG-009q3: shouldResumeBucketSession — Gemini expired or missing bucket timestamp forces fresh session', () => {
    const now = Date.parse('2026-05-08T00:00:00Z');
    const stale = now - (73 * 60 * 60 * 1000);
    assert.equal(shouldResumeBucketSession('gemini', 'gemini-2.5-pro', 'gemini-2.5-pro', null, null, stale, now), false);
    assert.equal(shouldResumeBucketSession('gemini', 'gemini-2.5-pro', 'gemini-2.5-pro', null, null, null, now), false);
});

test('AG-009r: shouldResumeBucketSession — OpenCode stale resume key forces fresh session', () => {
    assert.equal(shouldResumeBucketSession('opencode', 'opencode-go/kimi-k2.6', 'opencode-go/kimi-k2.6', 'exa=1', null), false);
    assert.equal(shouldResumeBucketSession('opencode', 'opencode-go/kimi-k2.6', 'opencode-go/kimi-k2.6', 'exa=1', 'exa=0'), false);
});

test('AG-009s: shouldResumeBucketSession — OpenCode matching resume key still resumes', () => {
    assert.equal(shouldResumeBucketSession('opencode', 'opencode-go/kimi-k2.6', 'opencode-go/kimi-k2.6', 'exa=1', 'exa=1'), true);
});

test('AG-009e: codex Spark resume also strips reasoning config', () => {
    const args = buildResumeArgs('codex', 'gpt-5.3-spark', 'high', 'sess-123', 'continue', 'auto');
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(!cVals.some(v => v.includes('model_reasoning_summary')), 'spark resume must drop summary');
    assert.ok(!cVals.some(v => v.includes('hide_agent_reasoning')), 'spark resume must drop hide flag');
    assert.ok(!cVals.some(v => v.includes('show_raw_agent_reasoning')), 'spark resume must drop raw reasoning flag');
});

test('AG-009f: spark detection is case-insensitive and matches substring', () => {
    for (const m of ['gpt-5.3-spark', 'GPT-5-Spark', 'codex-spark-mini', 'Spark']) {
        const args = buildArgs('codex', m, 'high', '', '', 'auto');
        const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
        assert.ok(!cVals.some(v => v.includes('reasoning')), `${m} should drop reasoning config`);
    }
});

// ─── buildArgs: gemini ───────────────────────────────

test('AG-010: gemini includes prompt payload via -p', () => {
    const args = buildArgs('gemini', 'gemini-2.5-pro', '', 'hello world', '', 'safe');
    const pIdx = args.indexOf('-p');
    assert.ok(pIdx >= 0);
    assert.equal(args[pIdx + 1], 'hello world');
});

test('AG-011: gemini with model includes -m', () => {
    const args = buildArgs('gemini', 'gemini-2.5-pro', '', 'hi', '', 'safe');
    assert.ok(args.includes('-m'));
    assert.ok(args.includes('gemini-2.5-pro'));
});

test('AG-012: gemini default model excludes -m', () => {
    const args = buildArgs('gemini', 'default', '', 'hi', '', 'safe');
    assert.ok(!args.includes('-m'));
});

test('AG-012a: gemini fresh sessions include trusted full-home workspace access', () => {
    const args = buildArgs('gemini', 'default', '', 'hi', '', 'auto', { homedir: '/home/jun' });
    assert.ok(args.includes('--skip-trust'));
    assert.ok(args.includes('--approval-mode'));
    assert.ok(args.includes('yolo'));
    const includeIdx = args.indexOf('--include-directories');
    assert.ok(includeIdx >= 0);
    assert.equal(args[includeIdx + 1], '/home/jun');
    assert.ok(!args.includes('~'));
    assert.ok(!args.includes('-y'));
});

test('AG-012b: gemini WSL sessions include Windows user home when available', () => {
    const dirs = resolveGeminiIncludeDirectories({
        homedir: '/home/jun',
        platform: 'linux',
        release: '5.15.90.1-microsoft-standard-WSL2',
        env: { USER: 'jun' },
        pathExists: (path) => path === '/mnt/c/Users/jun',
    });
    assert.deepEqual(dirs, ['/home/jun', '/mnt/c/Users/jun']);
});

test('AG-012c: gemini include directories are deduped and capped at five', () => {
    const dirs = resolveGeminiIncludeDirectories({
        homedir: '/home/jun/',
        includeDirectories: ['/home/jun', '/a', '/b', '/c', '/d', '/e'],
    });
    assert.deepEqual(dirs, ['/home/jun', '/a', '/b', '/c', '/d']);
});

test('AG-012d: gemini configured include directories are passed as repeated flags', () => {
    const args = buildArgs('gemini', 'default', '', 'hi', '', 'auto', {
        homedir: '/home/jun',
        includeDirectories: ['/mnt/c/Users/jun/Downloads'],
    });
    const pairs = args
        .map((value, index) => [value, args[index + 1]] as const)
        .filter(([value]) => value === '--include-directories')
        .map(([, value]) => value);
    assert.deepEqual(pairs, ['/home/jun', '/mnt/c/Users/jun/Downloads']);
});

// ─── buildArgs: grok ─────────────────────────────────

test('AG-012e: grok fresh sessions use headless prompt + streaming-json', () => {
    const args = buildArgs('grok', 'grok-build', 'high', 'hello grok', 'system ignored', 'auto');
    const promptIdx = args.indexOf('-p');
    assert.ok(promptIdx >= 0);
    assert.equal(args[promptIdx + 1], 'hello grok');
    assert.ok(args.includes('-m'));
    assert.ok(args.includes('grok-build'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('streaming-json'));
    assert.ok(args.includes('--no-alt-screen'));
    assert.ok(args.includes('--always-approve'));
    assert.ok(args.includes('--permission-mode'));
    assert.ok(args.includes('bypassPermissions'));
});

test('AG-012f: grok never receives effort or system prompt flags', () => {
    const args = buildArgs('grok', 'grok-build', 'max', 'hi', 'system ignored', 'auto');
    assert.ok(!args.includes('--effort'));
    assert.ok(!args.includes('--reasoning-effort'));
    assert.ok(!args.includes('--rules'));
    assert.ok(!args.includes('--system-prompt-override'));
    assert.ok(!args.includes('--append-system-prompt'));
});

test('AG-012g: grok safe permissions omit bypass flags', () => {
    const args = buildArgs('grok', 'grok-build', '', 'hi', '', 'safe');
    assert.ok(!args.includes('--always-approve'));
    assert.ok(!args.includes('bypassPermissions'));
});

// ─── buildArgs: unknown ──────────────────────────────

test('AG-013: unknown CLI returns empty args', () => {
    const args = buildArgs('nonexistent', 'x', '', 'hi', '', 'auto');
    assert.deepEqual(args, []);
});

// ─── buildResumeArgs ─────────────────────────────────

test('AG-014: claude resume includes --resume + session id', () => {
    const args = buildResumeArgs('claude', 'default', '', 'sess-abc-123', 'next task', 'auto');
    assert.ok(args.includes('--resume'));
    assert.ok(args.includes('sess-abc-123'));
});

test('AG-014a: claude-e resume forwards system prompt through wrapper extra args', () => {
    const args = buildResumeArgs('claude-e', 'sonnet', 'high', 'sess-abc-123', 'next task', 'auto', {
        sysPrompt: 'resume system instructions',
    });
    assert.ok(args.includes('--resume'));
    assert.ok(args.includes('sess-abc-123'));
    const separatorIdx = args.indexOf('--');
    assert.ok(separatorIdx >= 0, 'claude-e must use -- before forwarded Claude args');
    const forwarded = args.slice(separatorIdx + 1);
    assert.ok(forwarded.includes('--append-system-prompt'));
    assert.ok(forwarded.includes('resume system instructions'));
});

test('AG-015: codex resume includes session id', () => {
    const args = buildResumeArgs('codex', 'default', '', 'sess-123', 'continue', 'auto');
    assert.ok(args.includes('sess-123'));
    assert.ok(args.includes('resume'));
});

test('AG-016: gemini resume includes --resume', () => {
    const args = buildResumeArgs('gemini', 'default', '', 'sess-456', 'go', 'safe', { homedir: 'C:\\Users\\jun' });
    assert.ok(args.includes('--resume'));
    assert.ok(args.includes('sess-456'));
    const includeIdx = args.indexOf('--include-directories');
    assert.ok(includeIdx >= 0);
    assert.equal(args[includeIdx + 1], 'C:\\Users\\jun');
});

test('AG-016b: grok resume uses --resume and still omits effort/system prompt flags', () => {
    const args = buildResumeArgs('grok', 'grok-build', 'max', 'grok-session-1', 'continue', 'auto', {
        sysPrompt: 'system ignored',
    });
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('continue'));
    assert.ok(args.includes('--resume'));
    assert.ok(args.includes('grok-session-1'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('streaming-json'));
    assert.ok(!args.includes('--effort'));
    assert.ok(!args.includes('--reasoning-effort'));
    assert.ok(!args.includes('--rules'));
    assert.ok(!args.includes('--system-prompt-override'));
    assert.ok(!args.includes('--append-system-prompt'));
});

test('AG-017: opencode auto permissions omit unsupported skip-permissions flag', () => {
    const args = buildArgs('opencode', 'opencode-go/kimi-k2.6', 'high', 'hi', '', 'auto');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('--format'));
    assert.ok(args.includes('--thinking'));
});

test('AG-018: opencode yolo permissions omit unsupported skip-permissions flag', () => {
    const args = buildArgs('opencode', 'opencode-go/kimi-k2.6', 'high', 'hi', '', 'yolo');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('AG-019: opencode safe permissions exclude dangerously-skip-permissions', () => {
    const args = buildArgs('opencode', 'opencode-go/kimi-k2.6', 'high', 'hi', '', 'safe');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('AG-020: opencode resume auto permissions omit unsupported skip-permissions flag', () => {
    const args = buildResumeArgs('opencode', 'opencode-go/kimi-k2.6', 'high', 'sess-oc-1', 'continue', 'auto');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('--thinking'));
});

test('AG-021: opencode empty effort still includes thinking without variant', () => {
    const args = buildArgs('opencode', 'opencode-go/kimi-k2.6', '', 'hi', '', 'auto');
    assert.ok(args.includes('--thinking'));
    assert.ok(!args.includes('--variant'));
});

test('AG-022: opencode explicit effort includes variant and thinking', () => {
    const args = buildArgs('opencode', 'opencode-go/kimi-k2.6', 'high', 'hi', '', 'auto');
    assert.ok(args.includes('--thinking'));
    assert.ok(args.includes('--variant'));
    assert.ok(args.includes('high'));
});

test('AG-023: opencode resume empty effort still includes thinking without variant', () => {
    const args = buildResumeArgs('opencode', 'opencode-go/kimi-k2.6', '', 'sess-oc-1', 'continue', 'auto');
    assert.ok(args.includes('--thinking'));
    assert.ok(!args.includes('--variant'));
});

// ─── buildArgs: claude fast mode (perCli.<cli>.fastMode → --settings) ──

test('AG-024: claude omits --settings when fastMode is off (opt-in only)', () => {
    const args = buildArgs('claude', 'default', '', 'hi', '', 'auto');
    assert.ok(!args.includes('--settings'), 'fast mode must not be emitted unless requested');
});

test('AG-025: claude with fastMode injects --settings {"fastMode":true}', () => {
    const args = buildArgs('claude', 'default', '', 'hi', '', 'auto', { fastMode: true });
    const idx = args.indexOf('--settings');
    assert.notEqual(idx, -1, '--settings flag should be present');
    assert.equal(args[idx + 1], '{"fastMode":true}');
});

test('AG-026: claude resume with fastMode injects --settings {"fastMode":true}', () => {
    const args = buildResumeArgs('claude', 'default', '', 'sess-fast-1', 'go', 'auto', { fastMode: true });
    const idx = args.indexOf('--settings');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], '{"fastMode":true}');
});

test('AG-027: claude-e with fastMode forwards --settings after the -- separator', () => {
    const args = buildArgs('claude-e', 'sonnet', 'medium', 'hi', '', 'auto', { fastMode: true });
    const separatorIdx = args.indexOf('--');
    const settingsIdx = args.indexOf('--settings');
    assert.ok(separatorIdx >= 0, 'claude-e must use -- before forwarded Claude args');
    assert.ok(settingsIdx > separatorIdx, '--settings must be forwarded to the underlying claude binary');
    assert.equal(args[settingsIdx + 1], '{"fastMode":true}');
});

test('AG-028: ai-e claude with fastMode forwards --settings to claude', () => {
    const args = buildArgs('ai-e', 'sonnet', 'medium', 'hi', '', 'auto', { aiEProvider: 'claude', fastMode: true });
    const idx = args.indexOf('--settings');
    assert.notEqual(idx, -1);
    assert.equal(args[idx + 1], '{"fastMode":true}');
});

test('AG-029: codex fastMode still maps to service_tier="fast" and never gets --settings', () => {
    const args = buildArgs('codex', 'gpt-5.4', 'high', 'x', '', 'auto', { fastMode: true });
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(cVals.includes('service_tier="fast"'));
    assert.ok(!args.includes('--settings'), 'codex must not receive the claude --settings flag');
});

test('AG-030: codex without fastMode explicitly sets service_tier="default"', () => {
    const args = buildArgs('codex', 'gpt-5.4', 'high', 'x', '', 'auto', { fastMode: false });
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(cVals.includes('service_tier="default"'), 'must explicitly pass default tier to prevent stale fast config');
});

test('AG-031: codex resume without fastMode explicitly sets service_tier="default"', () => {
    const args = buildResumeArgs('codex', 'gpt-5.4', 'high', 'sess-1', 'go', 'auto', { fastMode: false });
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(cVals.includes('service_tier="default"'), 'resume must override any persisted fast tier');
});
