import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initAgentPhases, isResetIntent } from '../../src/orchestrator/pipeline.ts';
import { parseWorklogPending } from '../../src/memory/worklog.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pipelineSrc = fs.readFileSync(join(__dirname, '../../src/orchestrator/pipeline.ts'), 'utf8');

test('EPF-001: end_phase 생략 시 기존 profile 유지', () => {
    const [ap] = initAgentPhases([{ agent: 'BE', role: 'backend', task: 'x', start_phase: 2 }]);
    assert.deepEqual(ap.phaseProfile, [2, 3, 4, 5]);
});

test('EPF-002: sparse fallback (docs start=4 end=4 -> [5])', () => {
    const [ap] = initAgentPhases([{ agent: 'DOC', role: 'docs', task: 'x', start_phase: 4, end_phase: 4 }]);
    assert.deepEqual(ap.phaseProfile, [5]);
});

test('EPF-003: parseWorklogPending 은 checkpoint(⏸)도 재개 대상으로 파싱', () => {
    const content = `## Agent Status Matrix
| Agent | Role | Phase | Gate |
|-------|------|-------|------|
| A | backend | Phase 4: 디버깅 | ⏸ checkpoint |
| B | docs | Phase 5: 통합검증 | ✅ 완료 |

## Execution Log
`;
    const pending = parseWorklogPending(content);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].agent, 'A');
    assert.equal(pending[0].currentPhase, 4);
});

test('RSF-001: isResetIntent 는 정확 매칭만 허용', () => {
    assert.equal(isResetIntent('리셋'), true);
    assert.equal(isResetIntent('리셋해'), true);
    assert.equal(isResetIntent('페이즈 리셋'), true);
    assert.equal(isResetIntent('phase reset'), true);
    assert.equal(isResetIntent('리셋해줘'), false);
    assert.equal(isResetIntent('reset now'), false);
});

test('RSF-002: orchestrateContinue 는 _skipClear=true 로 재개', () => {
    assert.ok(
        pipelineSrc.includes('return orchestrate(resumePrompt, { ...meta, _skipClear: true });'),
        'continue should preserve sessions by passing _skipClear=true',
    );
});

test('RSF-003: orchestrateReset 은 세션 삭제 + worklog reset 상태 업데이트', () => {
    assert.ok(
        pipelineSrc.includes('clearAllEmployeeSessions.run();'),
        'reset should clear all employee sessions',
    );
    assert.ok(
        pipelineSrc.includes("updateWorklogStatus(latest.path, 'reset', 0);"),
        'reset should mark worklog status as reset',
    );
});
