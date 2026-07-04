/**
 * Design page schema (186 Phase 2). `page.json` is the source of truth for a
 * page; validation failures NEVER delete a page — they surface as a schema
 * warning and `rescan` is the recovery path.
 */

export type DesignPageJson = {
    id: string;
    title: string;
    artifactKind: 'html';
    /** Absolute projectDir the page is bound to, or null for the default pool. */
    projectKey: string | null;
    createdAt: string;
    updatedAt: string;
    revision: number;
    exportTarget: string | null;
};

export type DesignPageValidation =
    | { ok: true; page: DesignPageJson }
    | { ok: false; error: string };

const MAX_TITLE = 300;

export function validateDesignPageJson(value: unknown): DesignPageValidation {
    if (!value || typeof value !== 'object') return { ok: false, error: 'page.json is not an object' };
    const raw = value as Record<string, unknown>;
    if (typeof raw['id'] !== 'string' || raw['id'].length === 0) return { ok: false, error: 'id missing' };
    if (typeof raw['title'] !== 'string' || raw['title'].length === 0) return { ok: false, error: 'title missing' };
    if (raw['artifactKind'] !== 'html') return { ok: false, error: `unsupported artifactKind: ${String(raw['artifactKind'])}` };
    if (raw['projectKey'] !== null && typeof raw['projectKey'] !== 'string') return { ok: false, error: 'projectKey must be string or null' };
    if (typeof raw['createdAt'] !== 'string' || Number.isNaN(Date.parse(raw['createdAt']))) return { ok: false, error: 'createdAt invalid' };
    if (typeof raw['updatedAt'] !== 'string' || Number.isNaN(Date.parse(raw['updatedAt']))) return { ok: false, error: 'updatedAt invalid' };
    if (typeof raw['revision'] !== 'number' || !Number.isInteger(raw['revision']) || raw['revision'] < 0) return { ok: false, error: 'revision invalid' };
    if (raw['exportTarget'] !== null && typeof raw['exportTarget'] !== 'string') return { ok: false, error: 'exportTarget must be string or null' };
    return {
        ok: true,
        page: {
            id: raw['id'],
            title: (raw['title'] as string).slice(0, MAX_TITLE),
            artifactKind: 'html',
            projectKey: (raw['projectKey'] as string | null),
            createdAt: raw['createdAt'] as string,
            updatedAt: raw['updatedAt'] as string,
            revision: raw['revision'] as number,
            exportTarget: raw['exportTarget'] as string | null,
        },
    };
}

export function newDesignPageJson(input: { id: string; title: string; projectKey: string | null }): DesignPageJson {
    const now = new Date().toISOString();
    return {
        id: input.id,
        title: input.title.slice(0, MAX_TITLE),
        artifactKind: 'html',
        projectKey: input.projectKey,
        createdAt: now,
        updatedAt: now,
        revision: 1,
        exportTarget: null,
    };
}
