import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const roadmapDir = join(root, 'devlog', '_plan', '260618_cli_jaw_jwc_unified_roadmap');
const docPath = join(roadmapDir, '199_electron_rebuild_replace_computer_use_qa_plan.md');
const evidenceDir = join(roadmapDir, 'evidence_199_electron_replace');
const latestReplacementLog = join(evidenceDir, 'replacement_20260620_001014.log');
const evidenceIgnore = join(evidenceDir, '.gitignore');

function read(path: string): string {
    return readFileSync(path, 'utf8');
}

test('electron replacement QA devlog records installed app evidence and boundaries', { skip: !existsSync(docPath) && 'devlog submodule is not available' }, () => {
    const doc = read(docPath);

    assert.match(doc, /status: done/, 'replacement QA devlog must be marked done only after evidence is recorded');
    assert.match(doc, /\/Applications\/cli-jaw\.app/, 'devlog must identify the replaced installed app target');
    assert.match(doc, /24577/, 'devlog must identify the Electron Manager lane');
    assert.match(doc, /Computer Use/, 'devlog must include installed-app Computer Use evidence');
    assert.match(doc, /npm run electron:dist:mac/, 'devlog must record the authorized Electron rebuild command');
    assert.match(doc, /replacement_20260620_001014\.log/, 'devlog must point to the latest replacement log');
    assert.match(doc, /manager-DK3AVysv\.js/, 'devlog must record the installed asset shell after the monitor-lane fix');
    assert.match(doc, /current installed artifact/, 'devlog must avoid overclaiming broader parity');
    assert.match(doc, /git push.*git reset.*git clean/s, 'devlog must preserve forbidden git-operation boundaries');
});

test('electron replacement QA records Code transcript monitor leak root cause and fix', { skip: !existsSync(docPath) && 'devlog submodule is not available' }, () => {
    const doc = read(docPath);

    assert.match(doc, /Goal \/ PABCD/, 'devlog must name the leaked goal monitor visible in the screenshot');
    assert.match(doc, /Background tasks/, 'devlog must name the leaked background task monitor visible in the screenshot');
    assert.match(doc, /Workers/, 'devlog must name the leaked worker monitor visible in the screenshot');
    assert.match(doc, /CodeWorkbench\.tsx/, 'devlog must identify the source file that mounted the monitors');
    assert.match(doc, /hasInlineGoalMonitor.*false/s, 'devlog must record post-fix runtime evidence for the goal monitor');
    assert.match(doc, /hasInlineBackgroundMonitor.*false/s, 'devlog must record post-fix runtime evidence for the background monitor');
    assert.match(doc, /hasInlineWorkerMonitor.*false/s, 'devlog must record post-fix runtime evidence for the worker monitor');
});

test('electron replacement evidence keeps large app backups local-only', { skip: !existsSync(evidenceDir) && 'replacement evidence directory is not available' }, () => {
    assert.equal(existsSync(latestReplacementLog), true, 'latest replacement log must exist');
    assert.equal(existsSync(evidenceIgnore), true, 'evidence directory must ignore local .app backups');

    const ignore = read(evidenceIgnore);
    const latestLog = read(latestReplacementLog);

    assert.match(ignore, /cli-jaw\.app\.before\.\*/, 'large installed-app backups must not be committed');
    assert.match(ignore, /!replacement_\*\.log/, 'small replacement logs must stay committable despite global log ignores');
    assert.match(latestLog, /installed server-root binding verified/, 'latest replacement log must prove installed server binding');
    assert.match(latestLog, /manager-DK3AVysv\.js/, 'latest replacement log must prove the post-fix manager asset shell');
    assert.doesNotMatch(latestLog, /git push|git reset|git clean/, 'replacement evidence must not include forbidden git operations');
});
