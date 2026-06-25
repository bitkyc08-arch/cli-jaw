import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { JAW_HOME } from '../../core/config.js';
import type { WebAiArtifactDescriptor } from './types.js';

/**
 * Session-artifact save helpers. Strict-TS port of agbrowse web-ai/session-artifacts.mjs
 * (parity catalog 101 #7, P0 foundation). Pure FS + descriptor building — store mutation
 * (appendSessionArtifact) lives in session.ts to keep the store boundary clean.
 */

export type ArtifactSaveResult =
    | { ok: true; descriptor: WebAiArtifactDescriptor }
    | { ok: false; stage: string; error: string };

interface BinaryArtifactInput {
    filename: string;
    buffer: Buffer;
    mimeType: string;
    sourceUrl?: string;
}

/** Sanitize a path segment to prevent directory traversal. */
function sanitizeSegment(segment: string): string {
    return segment.replace(/[/\\:*?"<>|.]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

/**
 * Resolve the artifacts directory for a session, under JAW_HOME (cli-jaw home — not
 * agbrowse's ~/.browser-agent). Created lazily on first write, not eagerly.
 */
export function resolveArtifactsDir(sessionId: string): string {
    return join(JAW_HOME, 'web-ai-artifacts', sanitizeSegment(sessionId));
}

function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function saveTranscript(sessionId: string, markdown: string): WebAiArtifactDescriptor {
    const dir = resolveArtifactsDir(sessionId);
    ensureDir(dir);
    const filename = 'transcript.md';
    writeFileSync(join(dir, filename), markdown, 'utf8');
    return {
        kind: 'transcript',
        label: 'Conversation transcript',
        path: filename,
        mimeType: 'text/markdown',
        sizeBytes: Buffer.byteLength(markdown, 'utf8'),
        savedAt: new Date().toISOString(),
    };
}

export function trySaveTranscript(sessionId: string, markdown: string): ArtifactSaveResult {
    try {
        return { ok: true, descriptor: saveTranscript(sessionId, markdown) };
    } catch (err) {
        return { ok: false, stage: 'artifact-transcript', error: (err as Error)?.message || String(err) };
    }
}

export function saveReport(sessionId: string, report: { text: string; sources?: string[] }): WebAiArtifactDescriptor {
    const dir = resolveArtifactsDir(sessionId);
    ensureDir(dir);
    const filename = 'report.md';
    let content = report.text;
    if (report.sources?.length) {
        content += '\n\n## Sources\n' + report.sources.map((s, i) => `${i + 1}. ${s}`).join('\n');
    }
    writeFileSync(join(dir, filename), content, 'utf8');
    return {
        kind: 'report',
        label: 'Deep Research report',
        path: filename,
        mimeType: 'text/markdown',
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        savedAt: new Date().toISOString(),
    };
}

export function trySaveReport(sessionId: string, report: { text: string; sources?: string[] }): ArtifactSaveResult {
    try {
        return { ok: true, descriptor: saveReport(sessionId, report) };
    } catch (err) {
        return { ok: false, stage: 'artifact-report', error: (err as Error)?.message || String(err) };
    }
}

export function saveImageArtifact(sessionId: string, image: BinaryArtifactInput): WebAiArtifactDescriptor {
    const dir = resolveArtifactsDir(sessionId);
    ensureDir(dir);
    const ext = image.filename.split('.').pop() ?? '';
    const stem = basename(image.filename, ext ? '.' + ext : '');
    const safeName = sanitizeSegment(stem) + '.' + (image.mimeType.split('/')[1] || 'png');
    writeFileSync(join(dir, safeName), image.buffer);
    return {
        kind: 'image',
        label: image.filename,
        path: safeName,
        mimeType: image.mimeType,
        sizeBytes: image.buffer.length,
        ...(image.sourceUrl ? { sourceUrl: image.sourceUrl } : {}),
        savedAt: new Date().toISOString(),
    };
}

export function trySaveImageArtifact(sessionId: string, image: BinaryArtifactInput): ArtifactSaveResult {
    try {
        return { ok: true, descriptor: saveImageArtifact(sessionId, image) };
    } catch (err) {
        return { ok: false, stage: 'artifact-image', error: (err as Error)?.message || String(err) };
    }
}

/**
 * Build a safe artifact basename for a generic file: strip any directory, preserve the
 * resolved filename's extension when present, else fall back to the MIME subtype.
 */
function safeFileArtifactName(filename: string, mimeType: string): string {
    const base = basename(String(filename || ''));
    const dot = base.lastIndexOf('.');
    const stem = sanitizeSegment(dot > 0 ? base.slice(0, dot) : base);
    const rawExt = dot > 0 ? base.slice(dot + 1) : '';
    const mimeExt = mimeType ? ((mimeType.split('/')[1] ?? '').split(';')[0] ?? '') : '';
    const ext = sanitizeSegment(rawExt || mimeExt);
    return ext && ext !== 'unknown' ? `${stem}.${ext}` : stem;
}

export function saveFileArtifact(sessionId: string, file: BinaryArtifactInput): WebAiArtifactDescriptor {
    const dir = resolveArtifactsDir(sessionId);
    ensureDir(dir);
    const safeName = safeFileArtifactName(file.filename, file.mimeType);
    writeFileSync(join(dir, safeName), file.buffer);
    return {
        kind: 'file',
        label: file.filename,
        path: safeName,
        mimeType: file.mimeType,
        sizeBytes: file.buffer.length,
        ...(file.sourceUrl ? { sourceUrl: file.sourceUrl } : {}),
        savedAt: new Date().toISOString(),
    };
}

export function trySaveFileArtifact(sessionId: string, file: BinaryArtifactInput): ArtifactSaveResult {
    try {
        return { ok: true, descriptor: saveFileArtifact(sessionId, file) };
    } catch (err) {
        return { ok: false, stage: 'artifact-file', error: (err as Error)?.message || String(err) };
    }
}

export function saveDiagnosticsArtifact(
    sessionId: string,
    diag: { context?: string; domJson?: unknown; screenshotBuffer?: Buffer | null },
): WebAiArtifactDescriptor {
    const dir = resolveArtifactsDir(sessionId);
    ensureDir(dir);
    const stem = `diagnostics-${sanitizeSegment(diag.context || 'failure')}`;
    const jsonPath = `${stem}.json`;
    writeFileSync(join(dir, jsonPath), JSON.stringify(diag.domJson ?? {}, null, 2));
    const descriptor: WebAiArtifactDescriptor = {
        kind: 'diagnostics',
        label: diag.context || 'failure',
        path: jsonPath,
        mimeType: 'application/json',
        savedAt: new Date().toISOString(),
    };
    if (diag.screenshotBuffer) {
        const pngPath = `${stem}.png`;
        writeFileSync(join(dir, pngPath), diag.screenshotBuffer);
        descriptor.screenshotPath = pngPath;
    }
    return descriptor;
}

export function trySaveDiagnosticsArtifact(
    sessionId: string,
    diag: { context?: string; domJson?: unknown; screenshotBuffer?: Buffer | null },
): ArtifactSaveResult {
    try {
        return { ok: true, descriptor: saveDiagnosticsArtifact(sessionId, diag) };
    } catch (err) {
        return { ok: false, stage: 'artifact-diagnostics', error: (err as Error)?.message || String(err) };
    }
}
