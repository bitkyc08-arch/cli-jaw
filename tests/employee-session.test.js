// ─── Employee Session DB 단위 테스트 ──────────────────
// Phase 100: employee_sessions 테이블 CRUD + main session 보호 검증

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DB_SRC = path.join(ROOT, 'src/core/db.js');
const PIPELINE_SRC = path.join(ROOT, 'src/orchestrator/pipeline.js');

// ─── 1. employee_sessions 테이블 존재 확인 ──────────

test('P100-ES-001: employee_sessions 테이블 스키마가 db.js에 정의됨', () => {
    const src = fs.readFileSync(DB_SRC, 'utf8');
    assert.match(src, /CREATE TABLE IF NOT EXISTS employee_sessions/,
        'employee_sessions CREATE TABLE 문이 존재해야 함');
    assert.match(src, /employee_id\s+TEXT\s+PRIMARY KEY/,
        'employee_id가 PRIMARY KEY여야 함');
    assert.match(src, /session_id\s+TEXT/,
        'session_id 컬럼이 있어야 함');
    assert.match(src, /cli\s+TEXT/,
        'cli 컬럼이 있어야 함');
});

// ─── 2. getEmployeeSession — 없는 ID 조회 시 undefined ──

test('P100-ES-002: getEmployeeSession 없는 ID 조회 시 undefined', async () => {
    const { getEmployeeSession } = await import('../src/core/db.js');
    const result = getEmployeeSession.get('nonexistent_employee_999');
    assert.equal(result, undefined, '존재하지 않는 employee_id 조회 시 undefined 반환');
});

// ─── 3. upsertEmployeeSession — 저장 후 조회 일치 ──────

test('P100-ES-003: upsertEmployeeSession 저장 후 조회 일치', async () => {
    const { upsertEmployeeSession, getEmployeeSession, clearAllEmployeeSessions } = await import('../src/core/db.js');

    const testId = `test_emp_${Date.now()}`;
    const testSid = 'session_abc123';
    const testCli = 'codex';

    try {
        upsertEmployeeSession.run(testId, testSid, testCli);
        const row = getEmployeeSession.get(testId);

        assert.ok(row, '저장 후 조회 결과가 존재해야 함');
        assert.equal(row.employee_id, testId);
        assert.equal(row.session_id, testSid);
        assert.equal(row.cli, testCli);
    } finally {
        // cleanup: 테스트 데이터 삭제
        clearAllEmployeeSessions.run();
    }
});

// ─── 4. upsertEmployeeSession — 같은 ID로 업데이트 시 덮어쓰기 ──

test('P100-ES-004: upsertEmployeeSession 같은 ID로 업데이트 시 덮어쓰기', async () => {
    const { upsertEmployeeSession, getEmployeeSession, clearAllEmployeeSessions } = await import('../src/core/db.js');

    const testId = `test_emp_overwrite_${Date.now()}`;

    try {
        // 첫 저장
        upsertEmployeeSession.run(testId, 'session_old', 'claude');
        // 덮어쓰기
        upsertEmployeeSession.run(testId, 'session_new', 'codex');

        const row = getEmployeeSession.get(testId);
        assert.ok(row, '덮어쓰기 후에도 조회 가능해야 함');
        assert.equal(row.session_id, 'session_new', 'session_id가 새 값으로 업데이트');
        assert.equal(row.cli, 'codex', 'cli가 새 값으로 업데이트');
    } finally {
        clearAllEmployeeSessions.run();
    }
});

// ─── 5. clearAllEmployeeSessions — 전체 삭제 후 조회 시 undefined ──

test('P100-ES-005: clearAllEmployeeSessions 전체 삭제 후 조회 시 undefined', async () => {
    const { upsertEmployeeSession, getEmployeeSession, clearAllEmployeeSessions } = await import('../src/core/db.js');

    const id1 = `test_clear_1_${Date.now()}`;
    const id2 = `test_clear_2_${Date.now()}`;

    // 2개 저장
    upsertEmployeeSession.run(id1, 'sid1', 'claude');
    upsertEmployeeSession.run(id2, 'sid2', 'codex');

    // 전체 삭제
    clearAllEmployeeSessions.run();

    assert.equal(getEmployeeSession.get(id1), undefined, '삭제 후 첫 번째 조회 시 undefined');
    assert.equal(getEmployeeSession.get(id2), undefined, '삭제 후 두 번째 조회 시 undefined');
});

// ─── 6. clearAllEmployeeSessions가 main session 테이블 안 건드리는지 확인 ──

test('P100-ES-006: clearAllEmployeeSessions가 main session 테이블을 건드리지 않음', async () => {
    const { getSession, upsertEmployeeSession, clearAllEmployeeSessions } = await import('../src/core/db.js');

    // main session 상태 스냅샷
    const before = getSession();
    assert.ok(before, 'main session이 존재해야 함');

    // employee 데이터 추가 후 전체 삭제
    upsertEmployeeSession.run('test_main_guard', 'sid_guard', 'claude');
    clearAllEmployeeSessions.run();

    // main session 상태 확인
    const after = getSession();
    assert.ok(after, 'clearAll 후에도 main session이 존재해야 함');
    assert.equal(after.id, before.id, 'main session id 보존');
    assert.equal(after.active_cli, before.active_cli, 'main session active_cli 보존');
    assert.equal(after.session_id, before.session_id, 'main session session_id 보존');
});

// ─── 7. Phase 합치기 프롬프트에 '적극 권장' 문구 존재 확인 ──

test('P100-ES-007: Phase 합치기 프롬프트에 적극 권장 문구 포함', () => {
    const src = fs.readFileSync(PIPELINE_SRC, 'utf8');
    assert.match(src, /적극 권장/,
        'pipeline.js에 "적극 권장" 문구가 포함되어야 함');
    assert.match(src, /Phase 합치기/,
        'pipeline.js에 "Phase 합치기" 문구가 포함되어야 함');
    assert.match(src, /phases_completed/,
        'pipeline.js에 phases_completed 파싱 로직이 있어야 함');
});
