import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { parseWorklogPending, PHASES, upsertWorklogSection } from '../../src/memory/worklog.ts';

// Note: createWorklog, appendToWorklog, updateMatrix write to ~/.cli-jaw/worklogs/
// which requires JAW_HOME override. Testing only pure functions here.
// upsertWorklogSection takes an explicit wlPath, so it is safe to test with tmp files.
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

// ─── upsertWorklogSection (Phase 56.1) ───────────────

function makeTmpWorklog(initial: string): string {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'worklog-test-'));
    const path = join(dir, 'test.md');
    fs.writeFileSync(path, initial);
    return path;
}

test('upsertWorklogSection replaces existing section body (middle section)', async () => {
    const path = makeTmpWorklog(`# WL
## Plan
(대기 중)

## Verification Criteria
(대기 중)
`);
    await upsertWorklogSection(path, 'Plan', 'new plan body');
    const content = fs.readFileSync(path, 'utf8');
    assert.match(content, /## Plan\nnew plan body\n\s*## Verification Criteria/);
    assert.ok(!content.includes('(대기 중)\n\n## Verification'),
        'original placeholder under Plan must be removed');
});

test('upsertWorklogSection replaces last section up to EOF', async () => {
    const path = makeTmpWorklog(`# WL
## Final Summary
(미완료)
`);
    await upsertWorklogSection(path, 'Final Summary', 'done');
    const content = fs.readFileSync(path, 'utf8');
    assert.match(content, /## Final Summary\ndone\n$/);
    assert.ok(!content.includes('(미완료)'));
});

test('upsertWorklogSection appends new section when missing', async () => {
    const path = makeTmpWorklog(`# WL
## Plan
body
`);
    await upsertWorklogSection(path, 'Follow-up', 'fu body');
    const content = fs.readFileSync(path, 'utf8');
    assert.match(content, /## Follow-up\nfu body\n$/);
    // Existing Plan section preserved
    assert.match(content, /## Plan\nbody\n/);
});

test('upsertWorklogSection is silent when file does not exist', async () => {
    const ghost = join(os.tmpdir(), 'nonexistent-worklog-' + Date.now() + '.md');
    await upsertWorklogSection(ghost, 'Plan', 'x');
    assert.ok(!fs.existsSync(ghost), 'must not create the file');
});

test('upsertWorklogSection repeated calls overwrite (no accumulation)', async () => {
    const path = makeTmpWorklog(`# WL
## Plan
(대기 중)

## End
`);
    await upsertWorklogSection(path, 'Plan', 'first');
    await upsertWorklogSection(path, 'Plan', 'second');
    await upsertWorklogSection(path, 'Plan', 'third');
    const content = fs.readFileSync(path, 'utf8');
    assert.ok(content.includes('third'), 'latest body present');
    assert.ok(!content.includes('first'), 'first body replaced');
    assert.ok(!content.includes('second'), 'second body replaced');
    assert.ok(!content.includes('(대기 중)'), 'placeholder replaced');
});
