import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const devScaffoldingPath = join(root, 'skills_ref/jaw-dev-scaffolding/SKILL.md');
const devPath = join(root, 'skills_ref/jaw-dev/SKILL.md');
const devPabcdPath = join(root, 'skills_ref/jaw-dev-pabcd/SKILL.md');

const requiredDocs = [devScaffoldingPath, devPath, devPabcdPath];
const hasRequiredDocs = requiredDocs.every((path) => fs.existsSync(path));

function read(path: string): string {
    return fs.readFileSync(path, 'utf8');
}

test('DLC-001: dev-scaffolding documents decade-range lexicographic phase filenames', { skip: !hasRequiredDocs && 'public skills_ref submodule not checked out' }, () => {
    const skill = read(devScaffoldingPath);

    assert.match(skill, /decade-range/i);
    assert.match(skill, /00_.*plan\.md/);
    assert.match(skill, /bare semantic filenames/);
    assert.match(skill, /PLAN\.md/);
    assert.match(skill, /DIFF_PLAN\.md/);
    assert.match(skill, /PHASES\.md/);
    assert.match(skill, /RCA\.md/);
    assert.match(skill, /scan siblings and choose the next unused prefix/);
});

test('DLC-002: common dev and PABCD skills propagate the phase naming contract', { skip: !hasRequiredDocs && 'public skills_ref submodule not checked out' }, () => {
    const dev = read(devPath);
    const devPabcd = read(devPabcdPath);

    assert.match(dev, /decade-range/i);
    assert.match(dev, /00-09.*research/i);
    assert.match(dev, /PLAN\.md/);

    assert.match(devPabcd, /decade/i);
    assert.match(devPabcd, /00.*09.*[Rr]esearch/);
    assert.match(devPabcd, /PLAN\.md/);
});
