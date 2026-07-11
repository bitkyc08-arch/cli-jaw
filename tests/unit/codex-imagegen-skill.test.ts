import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const skillPath = path.join(root, 'skills_ref', 'codex-imagegen', 'SKILL.md');
const registryPath = path.join(root, 'skills_ref', 'registry.json');
const legacyPath = path.join(root, 'skills_ref', 'imagegen', 'SKILL.md');

test('codex-imagegen declares Codex-only native generation and delivery contracts', {
    skip: !fs.existsSync(skillPath) && 'skills_ref submodule not checked out',
}, () => {
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(skill, /name: codex-imagegen/);
    assert.match(skill, /precondition failed: not codex/);
    assert.match(skill, /native image-generation capability/i);
    assert.match(skill, /\.cli-jaw\/uploads\/<slug>-<timestamp>\.png/);
    assert.match(skill, /!\[concise descriptive alt\]\(\/absolute\/path/);
    assert.match(skill, /POST \/api\/channel\/send/);
    assert.match(skill, /channel.*telegram[\s\S]*channel.*discord/i);
    assert.match(skill, /Never both call `\/api\/channel\/send`/);
});

test('codex-imagegen registry entry has no dependency requirements', {
    skip: !fs.existsSync(registryPath) && 'skills_ref submodule not checked out',
}, () => {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const entry = registry.skills['codex-imagegen'];
    assert.ok(entry);
    assert.equal(Object.hasOwn(entry, 'requires'), false);
    assert.equal(entry.category, 'ai-media');
});

test('legacy API imagegen remains a separate OPENAI_API_KEY workflow', {
    skip: !fs.existsSync(legacyPath) && 'skills_ref submodule not checked out',
}, () => {
    const legacy = fs.readFileSync(legacyPath, 'utf8');
    assert.match(legacy, /OPENAI_API_KEY/);
    assert.match(legacy, /scripts\/image_gen\.py/);
});
