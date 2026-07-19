// Skill filter/search logic ported from public/js/features/skills.ts (pure).

export interface SkillItem {
    id: string;
    name?: string;
    description?: string;
    emoji?: string;
    category?: string;
    enabled: boolean;
    requires?: { env?: string[]; bins?: string[] };
    install?: string;
}

export const KNOWN_SKILL_CATS = ['productivity', 'communication', 'devtools', 'ai-media', 'utility', 'smarthome', 'automation'];

export const SKILL_FILTERS = ['all', 'installed', 'productivity', 'communication', 'devtools', 'ai-media', 'utility', 'smarthome', 'other'] as const;
export type SkillFilter = (typeof SKILL_FILTERS)[number];

export function matchesSkillSearch(skill: SkillItem, query: string): boolean {
    if (!query) return true;
    const haystack = [
        skill.id,
        skill.name,
        skill.description,
        skill.category,
        skill.requires?.env?.join(' '),
        skill.requires?.bins?.join(' '),
        skill.install,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
}

export function filterSkills(skills: SkillItem[], filter: SkillFilter, search: string): SkillItem[] {
    let filtered = skills;
    if (filter === 'installed') {
        filtered = skills.filter((skill) => skill.enabled);
    } else if (filter === 'other') {
        filtered = skills.filter((skill) => !KNOWN_SKILL_CATS.includes(skill.category || ''));
    } else if (filter !== 'all') {
        filtered = skills.filter((skill) => skill.category === filter);
    }
    const query = search.trim().toLowerCase();
    return filtered.filter((skill) => matchesSkillSearch(skill, query));
}
