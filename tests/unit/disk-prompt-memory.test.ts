import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JAW_HOME, PROMPTS_DIR, settings } from '../../src/core/config.ts';
import { drainLogRing } from '../../src/core/logger.ts';
import { getSystemPrompt, regenerateB } from '../../src/prompt/builder.ts';

test('disk prompt carries soul safety rules and resolved instance paths', () => {
    const workingDir = join(JAW_HOME, 'accounting-workspace');
    const soulDir = join(JAW_HOME, 'memory', 'structured', 'shared');
    mkdirSync(PROMPTS_DIR, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(soulDir, { recursive: true });

    settings.workingDir = workingDir;
    writeFileSync(join(PROMPTS_DIR, 'A-1.md'), '# System\n', 'utf8');
    writeFileSync(join(PROMPTS_DIR, 'A-2.md'), [
        '# User Configuration',
        '',
        '## Working Directory',
        '- ~/.cli-jaw',
        '',
    ].join('\n'), 'utf8');
    writeFileSync(join(soulDir, 'soul.md'), [
        '---',
        'trust_level: high',
        '---',
        '# 회계봇 운영 원칙',
        '',
        '- 금액과 계정 코드를 임의로 바꾸지 않는다.',
        '- 고객 자료를 외부로 전송하지 않는다.',
        `- ${'안전규칙'.repeat(850)}`,
        '- 장문 soul 끝까지 전달됨',
    ].join('\n'), 'utf8');

    regenerateB();
    const prompt = readFileSync(join(workingDir, 'AGENTS.md'), 'utf8');

    assert.match(prompt, /## Soul & Identity/);
    assert.match(prompt, /회계봇 운영 원칙/);
    assert.match(prompt, /금액과 계정 코드를 임의로 바꾸지 않는다/);
    assert.match(prompt, /장문 soul 끝까지 전달됨/,
        'a soul around the reported 3.4 KB size must not lose its trailing rules');
    assert.ok(prompt.includes(JAW_HOME), 'disk prompt must expose the resolved JAW_HOME');
    assert.ok(prompt.includes(workingDir), 'disk prompt must expose the resolved working directory');
    assert.doesNotMatch(prompt, /## Working Directory\s*\n- ~\/\.cli-jaw/,
        'the stock A2 working-directory placeholder must not survive disk generation');
});

test('oversized disk soul is bounded and truncation is visible in logs', () => {
    const soulDir = join(JAW_HOME, 'memory', 'structured', 'shared');
    mkdirSync(soulDir, { recursive: true });
    writeFileSync(join(soulDir, 'soul.md'), [
        '# Oversized Soul',
        'A'.repeat(7000),
        'TAIL_MUST_BE_TRUNCATED',
    ].join('\n'), 'utf8');

    drainLogRing();
    const prompt = getSystemPrompt({ forDisk: true });
    const logs = drainLogRing();

    assert.match(prompt, /## Soul & Identity/);
    assert.match(prompt, /\.\.\.\(truncated\)/);
    assert.doesNotMatch(prompt, /TAIL_MUST_BE_TRUNCATED/);
    assert.ok(logs.some(entry => entry.level === 'warn' && entry.text.includes('disk soul truncated')),
        'truncation must be observable instead of silently dropping soul content');
});
