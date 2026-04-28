/**
 * PRD32.7 — Attachment Policy and Upload Lifecycle (Phase A — Fail-Closed Scaffold)
 *
 * Attachment success must never be input-only. Visible chip / file-count /
 * upload UI plus sent-turn attachment evidence are required before any upload
 * is considered successful. Phase A keeps mutation rejected; Phase B adds the
 * live runtime once 32.4–32.6 are stable.
 */

export type AttachmentPolicyName = 'inline-only' | 'upload' | 'auto';

export interface AttachmentPreflightResult {
    ok: boolean;
    rejectedReason?: string;
    softWarnings: string[];
    basename: string;
    sizeBytes: number;
    extension: string;
}

export interface AttachmentRuntimeResult {
    ok: false;
    stage: 'attachment-preflight' | 'attachment-upload';
    error: string;
    usedFallbacks: string[];
}

const HARD_LIMIT_BYTES = 512 * 1024 * 1024;
const IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
const SOFT_SPREADSHEET_BYTES = 50 * 1024 * 1024;

const UNSUPPORTED_EXTENSIONS = new Set(['.gdoc', '.gsheet', '.gslides']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic']);
const SPREADSHEET_EXTENSIONS = new Set(['.csv', '.tsv', '.xls', '.xlsx']);

export function preflightAttachment(file: { path: string; sizeBytes: number; basename: string }): AttachmentPreflightResult {
    const extension = extractExtension(file.basename);
    const softWarnings: string[] = [];
    if (UNSUPPORTED_EXTENSIONS.has(extension)) {
        return {
            ok: false,
            rejectedReason: `unsupported extension: ${extension}`,
            softWarnings,
            basename: file.basename,
            sizeBytes: file.sizeBytes,
            extension,
        };
    }
    if (file.sizeBytes > HARD_LIMIT_BYTES) {
        return {
            ok: false,
            rejectedReason: `file exceeds 512MB hard limit (${file.sizeBytes})`,
            softWarnings,
            basename: file.basename,
            sizeBytes: file.sizeBytes,
            extension,
        };
    }
    if (IMAGE_EXTENSIONS.has(extension) && file.sizeBytes > IMAGE_LIMIT_BYTES) {
        return {
            ok: false,
            rejectedReason: `image exceeds 20MB limit (${file.sizeBytes})`,
            softWarnings,
            basename: file.basename,
            sizeBytes: file.sizeBytes,
            extension,
        };
    }
    if (SPREADSHEET_EXTENSIONS.has(extension) && file.sizeBytes > SOFT_SPREADSHEET_BYTES) {
        softWarnings.push(`spreadsheet over 50MB may be soft-blocked by ChatGPT (${file.sizeBytes})`);
    }
    return {
        ok: true,
        softWarnings,
        basename: file.basename,
        sizeBytes: file.sizeBytes,
        extension,
    };
}

/**
 * Phase A guard. Mutation is forbidden until Phase B; this wrapper exists so
 * higher layers can call `attachLocalFile()` and consistently get a redacted
 * fail-closed envelope.
 */
export async function attachLocalFile(): Promise<AttachmentRuntimeResult> {
    return {
        ok: false,
        stage: 'attachment-upload',
        error: 'attachment upload runtime is not enabled (PRD32.7 Phase B pending)',
        usedFallbacks: [],
    };
}

export async function clearComposerAttachments(): Promise<AttachmentRuntimeResult> {
    return {
        ok: false,
        stage: 'attachment-preflight',
        error: 'attachment runtime is not enabled (PRD32.7 Phase B pending)',
        usedFallbacks: [],
    };
}

export async function locateComposerUploadTarget(): Promise<AttachmentRuntimeResult> {
    return {
        ok: false,
        stage: 'attachment-preflight',
        error: 'attachment runtime is not enabled (PRD32.7 Phase B pending)',
        usedFallbacks: [],
    };
}

export async function waitForAttachmentAccepted(): Promise<AttachmentRuntimeResult> {
    return {
        ok: false,
        stage: 'attachment-upload',
        error: 'attachment runtime is not enabled (PRD32.7 Phase B pending)',
        usedFallbacks: [],
    };
}

export async function verifySentTurnAttachment(): Promise<AttachmentRuntimeResult> {
    return {
        ok: false,
        stage: 'attachment-upload',
        error: 'attachment runtime is not enabled (PRD32.7 Phase B pending)',
        usedFallbacks: [],
    };
}

function extractExtension(basename: string): string {
    const idx = basename.lastIndexOf('.');
    if (idx < 0) return '';
    return basename.slice(idx).toLowerCase();
}
