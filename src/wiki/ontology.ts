// Ontology normalization for the opt-in wiki.
//
// The vault is plain Markdown that must stay usable without cli-jaw, so a note whose
// frontmatter does not describe a known entity is still a perfectly good note. Nothing
// here rejects a document: unknown kinds, incomplete relations, and repeats come back as
// warnings beside whatever was understood. Refusing them would make the vault answer to
// this program rather than the other way round.
//
// This module takes an already-parsed object. It does no file or YAML reading, which
// keeps the frontmatter parser a single decision made in one place (041-B) instead of a
// second one growing here.

export type WikiEntityKind = 'person' | 'project' | 'system';

export type WikiEntity = {
    kind: WikiEntityKind;
    id?: string;
};

export type WikiRelation = {
    type: string;
    target: string;
};

export type OntologyWarning = {
    code: 'invalid_entity_kind' | 'invalid_relation' | 'duplicate_relation';
    path: string;
    message: string;
};

export type NormalizedOntology = {
    entity?: WikiEntity;
    relations: WikiRelation[];
    warnings: OntologyWarning[];
};

const KINDS: ReadonlySet<string> = new Set<WikiEntityKind>(['person', 'project', 'system']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads the entity and relation shape out of one note's frontmatter.
 *
 * `path` is carried through to every warning so a caller reporting several notes can say
 * which one each complaint came from.
 */
export function normalizeOntology(path: string, data: Record<string, unknown>): NormalizedOntology {
    const warnings: OntologyWarning[] = [];

    // A note with no `entity` key is the ordinary case, not a mistake, so it draws no
    // warning. Only a present-but-unusable value is worth telling the user about.
    let entity: WikiEntity | undefined;
    const rawEntity = data["entity"];
    if (rawEntity !== undefined && rawEntity !== null) {
        const kind = isPlainObject(rawEntity) ? trimmedString(rawEntity["kind"]) : '';
        if (KINDS.has(kind)) {
            const id = trimmedString((rawEntity as Record<string, unknown>)["id"]);
            entity = { kind: kind as WikiEntityKind, ...(id ? { id } : {}) };
        } else {
            warnings.push({
                code: 'invalid_entity_kind',
                path,
                message: 'entity.kind must be person, project, or system',
            });
        }
    }

    const relations: WikiRelation[] = [];
    const seen = new Set<string>();
    const rawRelations = Array.isArray(data["relations"]) ? data["relations"] : [];
    for (const raw of rawRelations) {
        const value = isPlainObject(raw) ? raw : {};
        const type = trimmedString(value["type"]);
        const target = trimmedString(value["target"]);
        if (!type || !target) {
            warnings.push({
                code: 'invalid_relation',
                path,
                message: 'relation type and target are required',
            });
            continue;
        }
        // Separated by a NUL so a type ending in the separator cannot collide with a
        // target beginning with it.
        const key = `${type}\0${target}`;
        if (seen.has(key)) {
            warnings.push({ code: 'duplicate_relation', path, message: `${type} -> ${target}` });
            continue;
        }
        seen.add(key);
        relations.push({ type, target });
    }

    return { ...(entity ? { entity } : {}), relations, warnings };
}
