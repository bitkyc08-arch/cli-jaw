import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CURSOR_MODEL_IDS, resolveCursorModelVariant, isCursorFullModelId } from '../../src/agent/cursor-runtime.ts';
import { buildArgs, buildResumeArgs } from '../../src/agent/args.ts';
import { shouldResumeBucketSession } from '../../src/agent/spawn/resume.ts';

test('Cursor effort resolves to model IDs instead of CLI flags', () => {
    assert.equal(resolveCursorModelVariant('auto', 'high'), 'auto');
    assert.equal(resolveCursorModelVariant('composer-2.5', 'medium-fast'), 'composer-2.5-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.5', 'medium-fast'), 'gpt-5.5-medium-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.5', 'xhigh'), 'gpt-5.5-extra-high');
    assert.equal(resolveCursorModelVariant('gpt-5.3-codex', 'medium-fast'), 'gpt-5.3-codex-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.3-codex', 'xhigh-fast'), 'gpt-5.3-codex-xhigh-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.2', 'medium-fast'), 'gpt-5.2-fast');
    assert.equal(resolveCursorModelVariant('gpt-5.4-mini', 'high-fast'), 'gpt-5.4-mini-high');
    assert.equal(resolveCursorModelVariant('grok-4.5', 'medium-fast'), 'grok-4.5-fast');
    assert.equal(resolveCursorModelVariant('grok-4.5', 'medium'), 'grok-4.5');
    assert.equal(resolveCursorModelVariant('claude-opus-4-7-thinking', 'high'), 'claude-opus-4-7-thinking-high');
    assert.equal(resolveCursorModelVariant('claude-opus-4-8-thinking', 'high'), 'claude-opus-4-8-thinking-high');
    assert.equal(resolveCursorModelVariant('claude-opus-4-8', 'max'), 'claude-opus-4-8-max');
});

test('Cursor full model IDs stay unchanged', () => {
    assert.equal(isCursorFullModelId('gpt-5.5-medium'), true);
    assert.equal(resolveCursorModelVariant('gpt-5.5-medium', 'high-fast'), 'gpt-5.5-medium');
    assert.equal(isCursorFullModelId('grok-4.5-fast'), false);
    assert.equal(resolveCursorModelVariant('grok-4.5-fast', 'high'), 'grok-4.5-fast');
});

test('Cursor model inventory mirrors observed cursor-agent list-models support', () => {
    assert.equal(CURSOR_MODEL_IDS.length, 135);
    assert.ok(CURSOR_MODEL_IDS.includes('composer-2.5-fast'));
    assert.ok(!CURSOR_MODEL_IDS.includes('grok-composer-2.5-fast'));
    assert.ok(CURSOR_MODEL_IDS.includes('gpt-5.5-extra-high-fast'));
    assert.ok(CURSOR_MODEL_IDS.includes('claude-opus-4-7-thinking-max-fast'));
    assert.ok(CURSOR_MODEL_IDS.includes('claude-opus-4-8-thinking-max-fast'));
    assert.ok(CURSOR_MODEL_IDS.includes('gemini-3.1-pro'));
    assert.ok(!CURSOR_MODEL_IDS.includes('grok-4.3'));
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'claude-sonnet-5', 'glm-5.2', 'kimi-k2.7-code', 'gemini-3-pro']) assert.ok(CURSOR_MODEL_IDS.includes(model));
    assert.ok(CURSOR_MODEL_IDS.includes('grok-4.5'));
    assert.ok(CURSOR_MODEL_IDS.includes('grok-4.5-fast'));
});

test('Cursor args use print mode, trust, stream-json, force only for auto permissions', () => {
    const args = buildArgs('cursor', 'gpt-5.5', 'medium-fast', 'hi', '', 'auto');
    assert.deepEqual(args, [
        '-p',
        '--trust',
        '--output-format', 'stream-json',
        '--model', 'gpt-5.5-medium-fast',
        '--force',
        'hi',
    ]);
    assert.equal(args.includes('--effort'), false);
    assert.equal(args.includes('--reasoning-effort'), false);
    assert.equal(args.includes('--thinking'), false);

    const safeArgs = buildArgs('cursor', 'gpt-5.5', 'medium-fast', 'hi', '', 'safe');
    assert.equal(safeArgs.includes('--force'), false);
});

test('Cursor resume args put --resume before print mode and preserve prompt positional shape', () => {
    const args = buildResumeArgs('cursor', 'gpt-5.5', 'high-fast', 'sid-1', 'resume hi', 'auto');
    assert.deepEqual(args, [
        '--resume', 'sid-1',
        '-p',
        '--trust',
        '--output-format', 'stream-json',
        '--model', 'gpt-5.5-high-fast',
        '--force',
        'resume hi',
    ]);
});

test('Cursor resume rejects cross-effort bucket reuse', () => {
    assert.equal(
        shouldResumeBucketSession('cursor', 'gpt-5.5-medium-fast', 'gpt-5.5-medium-fast'),
        true,
    );
    assert.equal(
        shouldResumeBucketSession('cursor', 'gpt-5.5-high-fast', 'gpt-5.5-medium-fast'),
        false,
    );
});

test('Cursor spawn plan computes runtimeModel before session boundaries', () => {
    const src = fs.readFileSync('src/agent/spawn.ts', 'utf8');
    assert.match(src, /const runtimeModel = cli === 'cursor'/);
    assert.match(src, /resolveSessionBucket\(cli, runtimeModel/);
    assert.match(src, /shouldResumeBucketSession\(\s*cli,\s*runtimeModel/);
    assert.match(src, /buildArgs\(cli, runtimeModel/);
    assert.match(src, /model: runtimeModel/);
});
