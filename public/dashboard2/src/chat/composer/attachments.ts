export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type AttachmentStatus = 'ready' | 'uploading' | 'uploaded' | 'error';

export interface ComposerAttachment {
    id: string;
    identity: string;
    file: File;
    status: AttachmentStatus;
    path?: string;
    error?: string;
}

export interface IntakeResult {
    items: ComposerAttachment[];
    duplicateCount: number;
}

export function attachmentIdentity(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
    return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export function intakeAttachments(
    current: readonly ComposerAttachment[],
    files: Iterable<File> | ArrayLike<File>,
    maxBytes = MAX_ATTACHMENT_BYTES,
): IntakeResult {
    const next = [...current];
    const identities = new Set(current.map(item => item.identity));
    let duplicateCount = 0;
    for (const file of Array.from(files as ArrayLike<File>)) {
        const identity = attachmentIdentity(file);
        if (identities.has(identity)) {
            duplicateCount += 1;
            continue;
        }
        identities.add(identity);
        const error = file.size > maxBytes ? `File exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB` : null;
        next.push({
            id: `${Date.now().toString(36)}-${next.length}-${Math.random().toString(36).slice(2, 8)}`,
            identity,
            file,
            status: error ? 'error' : 'ready',
            ...(error ? { error } : {}),
        });
    }
    return { items: next, duplicateCount };
}

export function filesFromTransfer(transfer: Pick<DataTransfer, 'files'> | null): File[] {
    return transfer ? Array.from(transfer.files) : [];
}

export function appendAttachmentPaths(prompt: string, paths: readonly string[]): string {
    const clean = paths.filter(Boolean);
    return clean.length ? [prompt.trim(), ...clean].filter(Boolean).join('\n') : prompt.trim();
}
