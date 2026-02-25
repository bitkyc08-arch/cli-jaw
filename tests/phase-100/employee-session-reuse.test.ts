import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PIPELINE = path.join(ROOT, 'src/orchestrator/pipeline.ts');
const DISTRIBUTE = path.join(ROOT, 'src/orchestrator/distribute.ts');
const SPAWN = path.join(ROOT, 'src/agent/spawn.ts');
const DB = path.join(ROOT, 'src/core/db.ts');

test('P100-001: pipeline uses employeeSessionId-based resume and global clear', () => {
    const src = fs.readFileSync(PIPELINE, 'utf8') + '\n' + fs.readFileSync(DISTRIBUTE, 'utf8');
    assert.match(src, /employeeSessionId:\s*canResume\s*\?\s*empSession!?\.session_id\s*:\s*undefined/);
    assert.match(src, /clearAllEmployeeSessions\.run\(\)/);
    assert.match(src, /upsertEmployeeSession\.run\(.*\.id,\s*r\.sessionId,\s*.*\.cli\)/);
});

test('P100-002: spawn guards main session update when employee session is used', () => {
    const src = fs.readFileSync(SPAWN, 'utf8');
    assert.match(src, /const\s+empSid\s*=\s*opts\.employeeSessionId\s*\|\|\s*null/);
    assert.match(src, /if\s*\(!forceNew\s*&&\s*!empSid\s*&&\s*ctx\.sessionId\s*&&\s*code\s*===\s*0\)/);
});

test('P100-003: db exports global employee session clear statement', () => {
    const src = fs.readFileSync(DB, 'utf8');
    assert.match(src, /export\s+const\s+clearAllEmployeeSessions\s*=\s*db\.prepare\('DELETE FROM employee_sessions'\)/);
});
