import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    filterSkills,
    KNOWN_SKILL_CATS,
    matchesSkillSearch,
    SKILL_FILTERS,
    type SkillItem,
} from '../../public/dashboard2/src/features/hover-dock/skill-filter.ts';
import { parseChannelHealth } from '../../public/dashboard2/src/features/hover-dock/channel-health.ts';
import { normalizeRegistry, toModelMap } from '../../public/dashboard2/src/features/hover-dock/cli-registry.ts';
import { unwrapData } from '../../public/dashboard2/src/features/hover-dock/dock-settings.ts';

test('hover dock is mounted from the workbench chat header, visible without selection', () => {
    const source = readFileSync(new URL('../../public/dashboard2/src/shell/Workbench.tsx', import.meta.url), 'utf8');
    assert.match(source, /import \{ HoverDock \} from '\.\.\/features\/hover-dock\/HoverDock\.tsx'/);
    assert.match(source, /<HoverDock key=\{selected\?\.port \?\? 'none'\} port=\{selected\?\.port \?\? null\} \/>/);
});

test('hover dock stays out of the frozen manager surface', async () => {
    const { readdirSync } = await import('node:fs');
    assert.throws(() => readdirSync(new URL('../../public/manager/src/hover-dock', import.meta.url)));
});

test('skill filter matches legacy sidebar semantics', () => {
    const skills: SkillItem[] = [
        { id: 'alpha', name: 'Alpha', category: 'devtools', enabled: true, description: 'dev tool' },
        { id: 'beta', name: 'Beta', category: 'automation', enabled: false },
        { id: 'gamma', name: 'Gamma', category: 'weird', enabled: true, install: 'brew install gamma' },
    ];
    assert.equal(filterSkills(skills, 'all', '').length, 3);
    assert.deepEqual(filterSkills(skills, 'installed', '').map((s) => s.id), ['alpha', 'gamma']);
    assert.deepEqual(filterSkills(skills, 'devtools', '').map((s) => s.id), ['alpha']);
    assert.deepEqual(filterSkills(skills, 'other', '').map((s) => s.id), ['gamma']);
    assert.ok(KNOWN_SKILL_CATS.includes('automation'));
    assert.ok(!SKILL_FILTERS.includes('automation'));
    assert.equal(matchesSkillSearch(skills[2]!, 'brew'), true);
    assert.equal(matchesSkillSearch(skills[0]!, 'missing'), false);
});

test('channel health parser mirrors transport-status-row contract', () => {
    const payload = {
        channels: {
            activeInbound: 'telegram',
            telegram: { configured: true, activeInbound: true, sendCapable: true },
            discord: { configured: false, activeInbound: false, sendCapable: false },
        },
    };
    const health = parseChannelHealth(payload);
    assert.equal(health?.activeInbound, 'telegram');
    assert.equal(parseChannelHealth({ channels: { activeInbound: 'sms' } }), null);
    assert.equal(parseChannelHealth(null), null);
});

test('cli registry normalize keeps provider maps and drops junk', () => {
    const registry = normalizeRegistry({
        codex: { label: 'Codex', models: ['gpt-5.5'], efforts: ['low'], effortNote: 'note' },
        junk: 'not-an-object',
        'ai-e': {
            label: 'AI-E',
            models: ['opus'],
            efforts: ['high'],
            providers: ['claude'],
            modelsByProvider: { claude: ['opus'] },
            effortsByProvider: { claude: ['high'] },
        },
    });
    assert.deepEqual(Object.keys(registry), ['codex', 'ai-e']);
    assert.deepEqual(registry['ai-e']?.modelsByProvider?.['claude'], ['opus']);
    assert.deepEqual(toModelMap(registry), { codex: ['gpt-5.5'], 'ai-e': ['opus'] });
});

test('unwrapData handles dual-response and bare payloads', () => {
    assert.deepEqual(unwrapData({ ok: true, data: { a: 1 } }), { a: 1 });
    assert.deepEqual(unwrapData({ b: 2 }), { b: 2 });
    assert.throws(() => unwrapData({ ok: false, data: null }));
});
