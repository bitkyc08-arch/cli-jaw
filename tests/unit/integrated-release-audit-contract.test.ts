import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const auditPath = join(root, 'devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/197_050_integrated_release_audit.md');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('050 integrated release audit connects final roadmap evidence and constraints', {
    skip: !existsSync(auditPath) && 'optional devlog submodule not checked out',
}, () => {
    const audit = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/197_050_integrated_release_audit.md');

    for (const required of [
        'PASS WITH CONSTRAINTS',
        'repo-current Manager/Code mode',
        'installed app parity is not claimed',
        'current-artifact-only',
        'Do not run `npm run electron:dist:mac`',
        'Do not replace `/Applications/cli-jaw.app`',
        '051 Code ACP child recovery',
        '052 TUI JWC parity boundary',
        '053 Terminal panel boundary',
        '054 Browser panel boundary',
        '055 Multi-surface QA Matrix',
        '056 Scope Exclusion Register',
        'focused suite 31/31 passed',
        'npm run typecheck',
        'npm run typecheck:frontend',
        'npm run build:frontend',
        'npm run build',
        'employee audit',
    ]) {
        assert.ok(audit.includes(required), `audit must include ${required}`);
    }
});

test('050 integrated release audit only closes after 055 and 056 are done', {
    skip: !existsSync(auditPath) && 'optional devlog submodule not checked out',
}, () => {
    const audit = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/197_050_integrated_release_audit.md');
    const matrix = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/195_055_multi_surface_qa_matrix.md');
    const scope = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/196_056_scope_exclusion_register.md');

    assert.match(matrix, /status: done/, '055 matrix must be done');
    assert.match(scope, /status: done/, '056 register must be done');
    assert.match(audit, /055 and 056 are complete/, 'audit must explicitly close the prior dependency gate');
    assert.doesNotMatch(audit, /PASS WITHOUT CONSTRAINTS|installed app parity: PASS|installed app parity PASS without/, 'audit must not overclaim forbidden installed-app parity');
});
