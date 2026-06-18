import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const registerPath = join(root, 'devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/196_056_scope_exclusion_register.md');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('056 scope exclusion register classifies all adjacent surfaces', {
    skip: !existsSync(registerPath) && 'optional devlog submodule not checked out',
}, () => {
    const register = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/196_056_scope_exclusion_register.md');

    for (const required of [
        'included',
        'boundary-only',
        'deferred',
        'explicitly forbidden',
        'Manager Code mode',
        'provider/model',
        'session/cwd/worktree',
        'permission/tool parsing',
        'Background task monitor',
        'Worker monitor',
        'TUI',
        'Terminal panel',
        'BrowserPanel',
        'Browser QA',
        'Child Jaw instance/Jaw mode',
        'Dashboard Board/Kanban connector',
        'Dashboard Reminders/Schedule',
        'Jawsidian Notes',
        'Doc panel',
        'Diff/Folder panel',
        'Dashboard memory federation',
        'Telegram/Discord',
        'Electron rebuild/replacement',
        'release publish/push',
    ]) {
        assert.ok(register.includes(required), `register must classify ${required}`);
    }

    assert.match(register, /왜 빠졌나/, 'register must answer why a surface is out of scope');
    assert.match(register, /Do not run `npm run electron:dist:mac`/, 'register must preserve the no Electron rebuild rule');
    assert.match(register, /Do not replace `\/Applications\/cli-jaw\.app`/, 'register must preserve the no installed app replacement rule');
});

test('056 register depends on the completed QA matrix before release audit resumes', {
    skip: !existsSync(registerPath) && 'optional devlog submodule not checked out',
}, () => {
    const register = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/196_056_scope_exclusion_register.md');
    const matrix = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/195_055_multi_surface_qa_matrix.md');
    const audit = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/190_050_integrated_release_audit_precheck.md');

    assert.match(matrix, /status: done/, '055 matrix must be completed before 056 closes scope');
    assert.match(register, /055 Multi-surface QA Matrix/, '056 must reference the completed QA matrix');
    assert.match(register, /050 Integrated Release Audit/, '056 must hand control back to the integrated release audit');
    assert.match(audit, /Re-open 050 only after 055 and 056\s+exist/, '050 audit must remain the post-055/056 gate');
});
