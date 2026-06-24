// ─── Skill Command Cache ──────────────────────────────
// Central cache for active skill → slash command entries.
// Uses registerSkillLoader() pattern to avoid circular imports with builder.ts.

export interface SkillCommandEntry {
    id: string;
    name: string;
    description: string;
    content: string;
}

type SkillLoader = () => Array<{ id: string; name: string; description: string; content: string }>;

let cache: SkillCommandEntry[] | null = null;
let loader: SkillLoader | null = null;

export function registerSkillLoader(fn: SkillLoader): void {
    loader = fn;
}

export function getSkillCommandsCache(): SkillCommandEntry[] {
    if (!cache) cache = rebuildCache();
    return cache;
}

export function invalidateSkillCommandsCache(): void {
    cache = null;
}

function rebuildCache(): SkillCommandEntry[] {
    if (!loader) return [];
    try {
        return (loader() || [])
            .filter(Boolean)
            .map((s: { id: string; name: string; description: string; content: string }) => ({
                id: s.id,
                name: s.name,
                description: s.description,
                content: s.content,
            }));
    } catch {
        return [];
    }
}
