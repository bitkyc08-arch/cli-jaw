import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorklogPending, PHASES } from '../../src/worklog.js';

// Note: createWorklog, appendToWorklog, updateMatrix write to ~/.cli-claw/worklogs/
// which requires CLAW_HOME override. Testing only pure functions here.
// Full I/O tests belong in integration/ with tmp-home helper.

// ─── PHASES constant ────────────────────────────────

test('PHASES maps 5 phases correctly', () => {
    assert.equal(Object.keys(PHASES).length, 5);
    assert.equal(PHASES[1], '기획');
    assert.equal(PHASES[2], '기획검증');
    assert.equal(PHASES[3], '개발');
    assert.equal(PHASES[4], '디버깅');
    assert.equal(PHASES[5], '통합검증');
});

// ─── parseWorklogPending ─────────────────────────────

test('parseWorklogPending extracts pending agents from matrix', () => {
    const content = `# Work Log: test
- Status: executing
- Rounds: 1/3

## Agent Status Matrix
| Agent | Role | Phase | Gate |
|-------|------|-------|------|
| A-1 | 기획 | Phase 1: 기획 | ✅ 완료 |
| B-dev | 개발자 | Phase 3: 개발 | ⏳ 진행 중 |
| B-qa | 검증 | Phase 5: 통합검증 | ⏳ 진행 중 |

## Execution Log
`;

    const pending = parseWorklogPending(content);
    assert.equal(pending.length, 2);
    assert.equal(pending[0].agent, 'B-dev');
    assert.equal(pending[0].role, '개발자');
    assert.equal(pending[0].currentPhase, 3);
    assert.equal(pending[1].agent, 'B-qa');
    assert.equal(pending[1].currentPhase, 5);
});

test('parseWorklogPending returns empty array when no pending agents', () => {
    const content = `# Work Log: done
- Status: completed

## Agent Status Matrix
| Agent | Role | Phase | Gate |
|-------|------|-------|------|
| A-1 | 기획 | Phase 1: 기획 | ✅ 완료 |

## Final Summary
`;
    assert.deepEqual(parseWorklogPending(content), []);
});

test('parseWorklogPending handles missing matrix section', () => {
    const content = `# Work Log: test\n- Status: planning\n`;
    assert.deepEqual(parseWorklogPending(content), []);
});

test('parseWorklogPending falls back to phase 1 when phase number is missing', () => {
    const content = `## Agent Status Matrix
| Agent | Role | Phase | Gate |
|-------|------|-------|------|
| B-x | role | unknown phase | ⏳ 진행 중 |

## Execution Log
`;
    const pending = parseWorklogPending(content);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].currentPhase, 1);
});

test('parseWorklogPending stops parsing at next section heading', () => {
    const content = `## Agent Status Matrix
| Agent | Role | Phase | Gate |
|-------|------|-------|------|
| A | r | Phase 2: 기획검증 | ⏳ 진행 중 |

## Execution Log
| B | r | Phase 3: 개발 | ⏳ 진행 중 |
`;
    const pending = parseWorklogPending(content);
    // B is under Execution Log, not Agent Status Matrix — should not be parsed
    assert.equal(pending.length, 1);
    assert.equal(pending[0].agent, 'A');
});
