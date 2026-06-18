import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const roadmapDir = join(root, 'devlog/_plan/260618_cli_jaw_jwc_unified_roadmap');

function readRoadmapDoc(file: string): string {
    return readFileSync(join(roadmapDir, file), 'utf8');
}

function assertFrontmatterStatus(file: string, status: string): void {
    const doc = readRoadmapDoc(file);
    assert.match(doc, new RegExp(`^status: ${status}$`, 'm'), `${file} must be status: ${status}`);
}

function assertFinishedTitle(file: string): void {
    const doc = readRoadmapDoc(file);
    assert.match(doc, /^# \(fin\) /m, `${file} must use a finished title`);
}

test('024a/025a and 027-035 roadmap docs are closed after final release audit', {
    skip: !existsSync(roadmapDir) && 'optional devlog submodule not checked out',
}, () => {
    const closedDocs = [
        '163_024a_025a_code_data_integrity_build.md',
        '164_027_worktree_context_header_build.md',
        '165_028_tool_parser_schema_build.md',
        '166_029_permission_mode_control_build.md',
        '170_030_composer_claude_grade_build.md',
        '171_031_resize_overflow_qa_build.md',
        '172_032_electron_package_runbook_build.md',
        '173_033_installed_app_smoke_current_app.md',
        '174_034_full_regression_matrix.md',
        '175_035_background_task_inventory.md',
    ];

    for (const file of closedDocs) {
        assertFrontmatterStatus(file, 'done');
        assertFinishedTitle(file);
    }
});

test('roadmap hygiene preserves deferred Electron replacement boundary', {
    skip: !existsSync(roadmapDir) && 'optional devlog submodule not checked out',
}, () => {
    const hygiene = readRoadmapDoc('198_roadmap_status_hygiene.md');
    const precheck = readRoadmapDoc('190_050_integrated_release_audit_precheck.md');
    const finalAudit = readRoadmapDoc('197_050_integrated_release_audit.md');

    assertFrontmatterStatus('190_050_integrated_release_audit_precheck.md', 'deferred');
    assertFrontmatterStatus('197_050_integrated_release_audit.md', 'done');
    assertFrontmatterStatus('198_roadmap_status_hygiene.md', 'done');
    assertFinishedTitle('198_roadmap_status_hygiene.md');

    for (const required of [
        'Do not run `npm run electron:dist:mac`',
        'Do not replace `/Applications/cli-jaw.app`',
        'web Manager `24576`',
        'Electron Manager `24577`',
        'current-artifact-only',
    ]) {
        assert.ok(hygiene.includes(required), `hygiene doc must preserve ${required}`);
    }

    assert.match(precheck, /status: deferred/, 'precheck remains a historical deferred gate');
    assert.match(finalAudit, /PASS WITH CONSTRAINTS/, 'final audit remains the closing authority');
});
