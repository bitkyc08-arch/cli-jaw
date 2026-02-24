// Phase 9.4: agent argument builder 단위 테스트
// 이미 export된 함수를 직접 검증 (추가 작업 없이 즉시 실행 가능)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, buildResumeArgs } from '../../src/agent/spawn.js';

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
