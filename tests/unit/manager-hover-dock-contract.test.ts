import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    filterSkills,
    KNOWN_SKILL_CATS,
    matchesSkillSearch,
    SKILL_FILTERS,
    type SkillItem,
} from '../../public/manager/src/hover-dock/skill-filter.ts';
import { parseChannelHealth } from '../../public/manager/src/hover-dock/channel-health.ts';
import { normalizeRegistry, toModelMap } from '../../public/manager/src/hover-dock/cli-registry.ts';
import { unwrapData } from '../../public/manager/src/hover-dock/dock-settings.ts';

test('hover dock is mounted from InstancePreview with port key', () => {
    const source = readFileSync(new URL('../../public/manager/src/InstancePreview.tsx', import.meta.url), 'utf8');
    assert.match(source, /import \{ HoverDock \} from '\.\/hover-dock\/HoverDock'/);
    assert.match(source, /<HoverDock key=\{props\.instance\.port\} port=\{props\.instance\.port\}/);
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
    // 'other' = unknown categories; 'automation' is known but has no button (legacy parity)
    assert.deepEqual(filterSkills(skills, 'other', '').map((s) => s.id), ['gamma']);
    assert.ok(KNOWN_SKILL_CATS.includes('automation'));
    assert.ok(!SKILL_FILTERS.includes('automation'));
    // search haystack: id/name/description/category/env/bins/install
    assert.equal(matchesSkillSearch(skills[2]!, 'brew'), true);
    assert.equal(matchesSkillSearch(skills[0]!, 'missing'), false);
    assert.deepEqual(filterSkills(skills, 'all', 'brew').map((s) => s.id), ['gamma']);
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
    assert.equal(health?.discord.configured, false);
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
    assert.equal(registry['codex']?.effortNote, 'note');
    assert.deepEqual(registry['ai-e']?.modelsByProvider?.['claude'], ['opus']);
    assert.deepEqual(toModelMap(registry), { codex: ['gpt-5.5'], 'ai-e': ['opus'] });
});

test('unwrapData handles dual-response and bare payloads', () => {
    assert.deepEqual(unwrapData({ ok: true, data: { a: 1 } }), { a: 1 });
    assert.deepEqual(unwrapData({ b: 2 }), { b: 2 });
    assert.throws(() => unwrapData({ ok: false, data: null }));
});
