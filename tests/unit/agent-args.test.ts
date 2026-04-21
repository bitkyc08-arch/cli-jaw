// Phase 9.4: agent argument builder 단위 테스트
// 이미 export된 함수를 직접 검증 (추가 작업 없이 즉시 실행 가능)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, buildResumeArgs, resolveSessionBucket, shouldResumeBucketSession } from '../../src/agent/spawn.ts';

// ─── buildArgs: claude ───────────────────────────────

test('AG-001: claude default excludes --model', () => {
    const args = buildArgs('claude', 'default', '', 'hello', '', 'auto');
    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--output-format'));
    assert.ok(!args.includes('--model'));
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
});

test('AG-009c: codex resume also injects reasoning summary override', () => {
    const args = buildResumeArgs('codex', 'default', '', 'sess-xyz', 'continue', 'auto');
    const cIdxs = args.reduce<number[]>((acc, v, i) => (v === '-c' ? [...acc, i] : acc), []);
    const cVals = cIdxs.map(i => args[i + 1]);
    assert.ok(cVals.includes('model_reasoning_summary="detailed"'), 'resume must also force detailed');
});

test('AG-009d: codex Spark model strips ALL reasoning config (effort + summary + hide)', () => {
    const args = buildArgs('codex', 'gpt-5.3-spark', 'high', 'x', '', 'auto');
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(!cVals.some(v => v.includes('model_reasoning_effort')), 'spark must drop model_reasoning_effort');
    assert.ok(!cVals.some(v => v.includes('model_reasoning_summary')), 'spark must drop model_reasoning_summary');
    assert.ok(!cVals.some(v => v.includes('hide_agent_reasoning')), 'spark must drop hide_agent_reasoning');
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

test('AG-009k: resolveSessionBucket — non-spark codex stays in codex bucket', () => {
    assert.equal(resolveSessionBucket('codex', 'gpt-5.4'), 'codex');
    assert.equal(resolveSessionBucket('codex', 'gpt-5.3-codex'), 'codex');
    assert.equal(resolveSessionBucket('codex', 'default'), 'codex');
    assert.equal(resolveSessionBucket('codex', ''), 'codex');
});

test('AG-009l: resolveSessionBucket — non-codex CLI returns cli unchanged', () => {
    assert.equal(resolveSessionBucket('claude', 'sonnet-spark-fake'), 'claude', 'spark check is codex-scoped');
    assert.equal(resolveSessionBucket('gemini', 'gemini-3-flash'), 'gemini');
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

test('AG-009q: shouldResumeBucketSession — non-Copilot CLIs keep current resume behavior', () => {
    assert.equal(shouldResumeBucketSession('claude', 'claude-opus-4-6', 'claude-sonnet-4-6'), true);
    assert.equal(shouldResumeBucketSession('gemini', 'gemini-2.5-pro', 'gemini-2.5-flash'), true);
    assert.equal(shouldResumeBucketSession('opencode', 'kimi-k2.6', 'kimi-k2.5'), true);
});

test('AG-009e: codex Spark resume also strips reasoning config', () => {
    const args = buildResumeArgs('codex', 'gpt-5.3-spark', 'high', 'sess-123', 'continue', 'auto');
    const cVals = args.reduce<string[]>((acc, v, i) => (v === '-c' ? [...acc, args[i + 1]] : acc), []);
    assert.ok(!cVals.some(v => v.includes('model_reasoning_summary')), 'spark resume must drop summary');
    assert.ok(!cVals.some(v => v.includes('hide_agent_reasoning')), 'spark resume must drop hide flag');
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

test('AG-015: codex resume includes session id', () => {
    const args = buildResumeArgs('codex', 'default', '', 'sess-123', 'continue', 'auto');
    assert.ok(args.includes('sess-123'));
    assert.ok(args.includes('resume'));
});

test('AG-016: gemini resume includes --resume', () => {
    const args = buildResumeArgs('gemini', 'default', '', 'sess-456', 'go', 'safe');
    assert.ok(args.includes('--resume'));
    assert.ok(args.includes('sess-456'));
});
