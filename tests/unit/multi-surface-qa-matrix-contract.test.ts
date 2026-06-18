import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const matrixPath = join(root, 'devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/195_055_multi_surface_qa_matrix.md');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

test('055 multi-surface QA matrix covers every release gate without proxy passes', {
    skip: !existsSync(matrixPath) && 'optional devlog submodule not checked out',
}, () => {
    const matrix = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/195_055_multi_surface_qa_matrix.md');

    for (const required of [
        'Manager Code mode',
        'Web Manager 24576',
        'Electron Manager 24577',
        'TUI',
        'Terminal panel',
        'BrowserPanel',
        'Browser QA',
        'web-ai background task',
        'Background task monitor',
        'Worker monitor',
        'Child Jaw instance 3465',
        'installed-artifact-only',
    ]) {
        assert.ok(matrix.includes(required), `matrix must cover ${required}`);
    }

    assert.match(matrix, /No proxy pass/, 'matrix must reject passing one surface on behalf of another');
    assert.match(matrix, /Do not run `npm run electron:dist:mac`/, 'matrix must preserve the no Electron rebuild rule');
    assert.match(matrix, /Do not replace `\/Applications\/cli-jaw\.app`/, 'matrix must preserve the no installed app replacement rule');
    assert.match(matrix, /```mermaid/, 'matrix must include a Mermaid visualization');
});

test('055 matrix depends on completed surface-boundary evidence', {
    skip: !existsSync(matrixPath) && 'optional devlog submodule not checked out',
}, () => {
    const matrix = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/195_055_multi_surface_qa_matrix.md');
    const tui = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/192_052_tui_jwc_parity_boundary.md');
    const terminal = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/193_053_terminal_panel_boundary.md');
    const browser = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/194_054_browser_panel_boundary.md');
    const installed = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/188_048_monitor_installed_app_smoke.md');
    const audit = read('devlog/_plan/260618_cli_jaw_jwc_unified_roadmap/190_050_integrated_release_audit_precheck.md');

    for (const doc of [tui, terminal, browser]) {
        assert.match(doc, /status: done/, 'surface boundary dependency must be done');
    }
    assert.match(installed, /current-artifact FAIL/, 'installed app result must stay current-artifact-only until replacement is approved');
    assert.match(audit, /055 multi-surface QA matrix and 056 scope exclusion register are not complete/, '050 must remain gated until 055 and 056 complete');
    assert.match(matrix, /052 TUI JWC parity boundary/, 'matrix must link the TUI boundary evidence');
    assert.match(matrix, /053 Terminal panel boundary/, 'matrix must link the Terminal boundary evidence');
    assert.match(matrix, /054 Browser panel boundary/, 'matrix must link the Browser boundary evidence');
});
