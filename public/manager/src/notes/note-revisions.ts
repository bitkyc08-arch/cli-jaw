import { DashboardApiError } from '../api';

export function isRevisionConflict(error: unknown): boolean {
    return error instanceof DashboardApiError
        && error.status === 409
        && error.code === 'note_revision_conflict';
}

export function noteDisplayName(path: string | null): string {
    if (!path) return 'No note selected';
    const parts = path.split('/').filter(Boolean);
    return parts.at(-1) || path;
}

export function canSaveNote(path: string | null, dirty: boolean, saving: boolean): boolean {
    return Boolean(path) && dirty && !saving;
}
