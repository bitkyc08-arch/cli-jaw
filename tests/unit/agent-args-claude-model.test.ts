import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, buildResumeArgs } from '../../src/agent/args.ts';

test('AA-001: buildArgs preserves explicit Claude full model names', () => {
    const args = buildArgs('claude', 'claude-sonnet-4-6[1m]', 'medium', '', '', 'auto');
    const modelIndex = args.indexOf('--model');
    assert.notEqual(modelIndex, -1, '--model flag should be present');
    assert.equal(args[modelIndex + 1], 'claude-sonnet-4-6[1m]');
});

test('AA-002: buildArgs preserves canonical alias models', () => {
    const args = buildArgs('claude', 'sonnet[1m]', 'medium', '', '', 'auto');
    const modelIndex = args.indexOf('--model');
    assert.notEqual(modelIndex, -1);
    assert.equal(args[modelIndex + 1], 'sonnet[1m]');
});

test('AA-003: buildArgs omits --model when value is default', () => {
    const args = buildArgs('claude', 'default', 'medium', '', '', 'auto');
    assert.equal(args.indexOf('--model'), -1, '--model should not be present for default');
});

test('AA-004: buildArgs omits --model when value is empty', () => {
    const args = buildArgs('claude', '', 'medium', '', '', 'auto');
    assert.equal(args.indexOf('--model'), -1, '--model should not be present for empty');
});

// ─── buildResumeArgs ─────────────────────────────────

test('AA-005: buildResumeArgs preserves explicit Claude full model names', () => {
    const args = buildResumeArgs('claude', 'claude-sonnet-4-6[1m]', 'medium', 'sess-123', '', 'auto');
    const modelIndex = args.indexOf('--model');
    assert.notEqual(modelIndex, -1, '--model flag should be present');
    assert.equal(args[modelIndex + 1], 'claude-sonnet-4-6[1m]');
});

test('AA-006: buildResumeArgs preserves canonical alias models', () => {
    const args = buildResumeArgs('claude', 'opus[1m]', 'medium', 'sess-123', '', 'auto');
    const modelIndex = args.indexOf('--model');
    assert.notEqual(modelIndex, -1);
    assert.equal(args[modelIndex + 1], 'opus[1m]');
});

test('AA-007: buildResumeArgs omits --model when default', () => {
    const args = buildResumeArgs('claude', 'default', 'medium', 'sess-123', '', 'auto');
    assert.equal(args.indexOf('--model'), -1);
});

test('AA-008: buildResumeArgs for codex preserves explicit model', () => {
    const args = buildResumeArgs('codex', 'gpt-5.4', 'high', 'sess-456', 'test', 'auto');
    const modelIndex = args.indexOf('--model');
    assert.notEqual(modelIndex, -1);
    assert.equal(args[modelIndex + 1], 'gpt-5.4');
});
