// Read-only entity index over the wiki vault.
//
// Three steps in a fixed order, and the order is the safety property: the bounded reader
// hands over text it has already vouched for, the parser turns that text into an object,
// and only then does ontology decide what the object means. Each stage takes what the
// previous one produced rather than a path, so none of them can reach the disk on its own.
//
// Nothing here rejects a note. A vault meant to outlive this program is full of documents
// that describe no entity at all, and that is the ordinary case rather than an error.

import { isWikiEnabled, storedWikiRoot } from './config.js';
import { normalizeOntology, type OntologyWarning, type WikiEntity, type WikiRelation } from './ontology.js';
import { parseLeadingFrontmatter } from '../notes/frontmatter.js';
import { scanVaultFiles, type ScanDeps, type ScanError, type ScanSkip } from './safe-traversal.js';

export type EntityRecord = {
    relPath: string;
    entity: WikiEntity;
    relations: WikiRelation[];
};

/** A file whose frontmatter could not be parsed at all — distinct from one whose ontology is wrong. */
export type ParseWarning = { code: 'frontmatter_parse_failed'; relPath: string; message: string };

export type EntityIndex = {
    status: 'off' | 'ok' | 'error';
    entities: EntityRecord[];
    /** Complaints about what the frontmatter said. */
    ontologyWarnings: OntologyWarning[];
    /** Complaints about the frontmatter not being readable as YAML. Kept apart on purpose:
     *  a reader cannot act on "this file is malformed" the way it acts on "this kind is
     *  not one I know". */
    parseWarnings: ParseWarning[];
    skipped: ScanSkip[];
    truncated: boolean;
    error?: ScanError;
};

const EMPTY: Omit<EntityIndex, 'status'> = {
    entities: [], ontologyWarnings: [], parseWarnings: [], skipped: [], truncated: false,
};

/**
 * Builds the entity index, or explains why it could not.
 *
 * The enabled check comes first and answers from settings alone, so a vault switched off
 * is never touched — not stat'ed, not resolved, not read.
 */
export function buildEntityIndex(deps?: ScanDeps): EntityIndex {
    if (!isWikiEnabled()) return { status: 'off', ...EMPTY };

    const scan = deps ? scanVaultFiles(storedWikiRoot(), deps) : scanVaultFiles(storedWikiRoot());
    if (!scan.ok) return { status: 'error', ...EMPTY, error: scan.error };

    const entities: EntityRecord[] = [];
    const ontologyWarnings: OntologyWarning[] = [];
    const parseWarnings: ParseWarning[] = [];

    for (const file of scan.files) {
        const parsed = parseLeadingFrontmatter(file.text);
        if (parsed.error) {
            parseWarnings.push({
                code: 'frontmatter_parse_failed',
                relPath: file.relPath,
                message: parsed.error,
            });
            continue;
        }
        const normalized = normalizeOntology(file.relPath, parsed.data);
        ontologyWarnings.push(...normalized.warnings);
        if (normalized.entity) {
            entities.push({
                relPath: file.relPath,
                entity: normalized.entity,
                relations: normalized.relations,
            });
        }
    }

    return {
        status: 'ok',
        entities,
        ontologyWarnings,
        parseWarnings,
        skipped: scan.skipped,
        truncated: scan.truncated,
    };
}
