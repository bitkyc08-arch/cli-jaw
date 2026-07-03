import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCoreProfileContent } from '../../src/memory/bootstrap.ts';

const core = `# Memory

## User Preferences
- Recovery lighthouse preference

## Key Decisions
- Preserve curated profile

## Active Projects
- Memory repair
`;

test('core profile sync preserves curated profile sections', () => {
    const original = `---\nsource_hash: old\nupdated_at: old\n---\n# Profile\n\n## Profile Summary\n- Ferrari fan\n\n## Personal Context\n- Seoul\n`;
    const updated = mergeCoreProfileContent(original, core, 'new-hash', '2026-06-28T00:00:00.000Z');

    assert.match(updated, /## Profile Summary\n- Ferrari fan/);
    assert.match(updated, /## Personal Context\n- Seoul/);
    assert.match(updated, /<!-- cli-jaw:core-memory:start -->/);
    assert.match(updated, /Recovery lighthouse preference/);
    assert.match(updated, /^source_hash: new-hash$/m);
    assert.match(updated, /^updated_at: 2026-06-28T00:00:00.000Z$/m);
});

test('core profile sync replaces only its managed block on later sync', () => {
    const original = `---\nsource_hash: old\n---\n# Profile\n\n## Profile Summary\n- Keep me\n\n<!-- cli-jaw:core-memory:start -->\nold managed data\n<!-- cli-jaw:core-memory:end -->\n`;
    const updated = mergeCoreProfileContent(original, core, 'new-hash');

    assert.match(updated, /## Profile Summary\n- Keep me/);
    assert.doesNotMatch(updated, /old managed data/);
    assert.equal((updated.match(/cli-jaw:core-memory:start/g) || []).length, 1);
});
