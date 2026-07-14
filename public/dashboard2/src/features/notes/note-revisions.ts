type RevisionError = Error & { status?: unknown; code?: unknown };

export function isRevisionConflict(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const revisionError = error as RevisionError;
    return revisionError.status === 409 && revisionError.code === 'note_revision_conflict';
}

export function noteDisplayName(path: string | null): string {
    if (!path) return 'No note selected';
    const parts = path.split('/').filter(Boolean);
    return parts.at(-1) || path;
}

export function canSaveNote(path: string | null, dirty: boolean, saving: boolean): boolean {
    return Boolean(path) && dirty && !saving;
}
