/**
 * lib/mcp/skills-aliases.ts
 * Legacy skill-id compatibility for the jaw-* namespace migration.
 *
 * The 30 default-active skills used to be named after the thing they do —
 * `browser`, `search`, `memory`, `desktop-control`. Those names collide with
 * Codex-native tools and skills, so a model reading the prompt could not tell
 * which runtime owned them. They now live under `jaw-*`.
 *
 * cli-jaw derives a skill id from its DIRECTORY name (see loadActiveSkills in
 * src/prompt/builder.ts), so the rename is a filesystem rename. This module is
 * the single place that knows the old names.
 *
 * Resolution is a READ-side concern only. Never resolve on the write path:
 * activation and directory creation must always use the canonical jaw id, or a
 * legacy directory gets recreated and the migration never finishes.
 */

/** Active skill ids as they were before the jaw-* namespace. */
export const LEGACY_ACTIVE_SKILL_IDS = [
    'pdf',
    'browser', 'memory', 'search',
    'screen-capture', 'docx', 'xlsx', 'pptx', 'hwp', 'github', 'telegram-send',
    'video', 'pdf-vision', 'diagram', 'structured-renderers',
    'desktop-control', 'goal',
    'dev', 'dev-architecture', 'dev-backend', 'dev-code-reviewer', 'dev-data',
    'dev-debugging', 'dev-devops', 'dev-frontend', 'dev-pabcd',
    'dev-scaffolding', 'dev-security', 'dev-testing', 'dev-uiux-design',
] as const;

export type LegacySkillId = typeof LEGACY_ACTIVE_SKILL_IDS[number];

/** The canonical prefix. Mirrors codexclaw's `cxc-`. */
export const JAW_SKILL_PREFIX = 'jaw-';

/**
 * legacy id -> canonical jaw id.
 *
 * Mechanical: prefix only, nothing else changes. `dev-frontend` becomes
 * `jaw-dev-frontend`, never `jaw-frontend` — keeping it mechanical is what
 * lets resolution be one lookup instead of a table nobody can remember.
 */
export const LEGACY_SKILL_ALIASES: ReadonlyMap<string, string> = new Map(
    LEGACY_ACTIVE_SKILL_IDS.map(id => [id, JAW_SKILL_PREFIX + id] as const),
);

/** True when `id` is a pre-migration name we still answer to. */
export function isLegacySkillId(id: string): boolean {
    return LEGACY_SKILL_ALIASES.has(String(id || '').trim());
}

/**
 * Canonical id for `id`. Returns the input untouched when it is already
 * canonical, a reference-only skill, or a user's own skill.
 */
export function resolveSkillId(id: string): string {
    const v = String(id || '').trim();
    return LEGACY_SKILL_ALIASES.get(v) ?? v;
}

/** One-line notice for CLI surfaces when someone types the old name. */
export function legacySkillIdNotice(id: string): string | null {
    const canonical = LEGACY_SKILL_ALIASES.get(String(id || '').trim());
    return canonical
        ? `note: '${id}' is now '${canonical}' — the old name still works for this major version`
        : null;
}

