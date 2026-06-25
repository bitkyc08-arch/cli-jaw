import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export type PageLike = {
    // @strict-allow-any(playwright evaluate interop boundary — in-page callbacks and results are untyped by design)
    evaluate: (fn: (...args: any[]) => unknown, arg?: unknown) => Promise<any>;
};

type ConversationMessage = { id?: string; content?: { content_type?: string }; create_time?: number; update_time?: number };
export type ConversationJson = { mapping?: Record<string, { message?: ConversationMessage }> };

/**
 * 104.11: iterate conversation messages in chronological order (create_time/update_time, then
 * mapping order) so the resolved zip is deterministic (the most recent one), not whichever the
 * unordered object iteration happened to hit last.
 */
function orderedConversationMessages(conversation: ConversationJson): ConversationMessage[] {
    return Object.values(conversation?.mapping || {})
        .map((node, index) => ({ message: node?.message, index }))
        .filter((item): item is { message: ConversationMessage; index: number } => Boolean(item.message))
        .sort((a, b) => {
            const at = Number(a.message.create_time ?? a.message.update_time);
            const bt = Number(b.message.create_time ?? b.message.update_time);
            const aHasTime = Number.isFinite(at);
            const bHasTime = Number.isFinite(bt);
            if (aHasTime && bHasTime && at !== bt) return at - bt;
            if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
            return a.index - b.index;
        })
        .map((item) => item.message);
}

export interface RetrieveResult {
    ok: boolean;
    reason: string | null;
    zipPath: string | null;
    savedPath: string | null;
    sizeBytes: number;
    files: string[];
    hasPlanArtifact?: boolean;
    mintedMessageId?: string | null;
}

const ZIP_PATH_RE = /\/mnt\/data\/[A-Za-z0-9_\-./]+\.zip/;
const ZIP_PATH_RE_GLOBAL = /\/mnt\/data\/[A-Za-z0-9_\-./]+\.zip/g;

export function scanConversationForZip(conversation: ConversationJson): { zipPath: string | null; candidateMids: string[] } {
    let zipPath: string | null = null;
    const candidateMids: string[] = [];
    for (const message of orderedConversationMessages(conversation)) {
        const contentType = message.content?.content_type || '';
        const blob = JSON.stringify(message.content || {});
        const match = blob.match(ZIP_PATH_RE);
        if (match) zipPath = match[0] || null;
        if ((contentType === 'execution_output' || contentType === 'code') && message.id) candidateMids.push(message.id);
    }
    return { zipPath, candidateMids };
}

export function scanConversationForAllZips(conversation: ConversationJson): { zipPaths: string[]; candidateMids: string[] } {
    const zipPaths: string[] = [];
    const seen = new Set<string>();
    const candidateMids: string[] = [];
    for (const message of orderedConversationMessages(conversation)) {
        const contentType = message.content?.content_type || '';
        const blob = JSON.stringify(message.content || {});
        for (const match of blob.match(ZIP_PATH_RE_GLOBAL) || []) {
            if (!seen.has(match)) { seen.add(match); zipPaths.push(match); }
        }
        if ((contentType === 'execution_output' || contentType === 'code') && message.id) candidateMids.push(message.id);
    }
    return { zipPaths, candidateMids };
}

export function verifyZipBuffer(buffer: Buffer): { files: string[] } | null {
    const entries = readZipCentralDirectory(buffer);
    if (!entries) return null;
    return { files: entries.map(entry => entry.name) };
}

export function hasPlanArtifact(files: string[]): boolean {
    return files.some(file => /(?:^|\/)(?:PLAN|00_plan)\.md$/i.test(file));
}

export function readZipTextEntry(buffer: Buffer, entryName: string): string | null {
    const entry = readZipCentralDirectory(buffer)?.find(candidate => candidate.name === entryName);
    if (!entry) return null;
    if (entry.localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) return null;
    const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) return null;
    const payload = buffer.subarray(dataStart, dataEnd);
    if (entry.method === 0) return payload.toString('utf8');
    if (entry.method === 8) return inflateRawSync(payload).toString('utf8');
    return null;
}

function readZipCentralDirectory(buffer: Buffer): Array<{ name: string; method: number; compressedSize: number; localHeaderOffset: number }> | null {
    if (!buffer || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return null;
    const eocdStart = Math.max(0, buffer.length - 22 - 65535);
    let eocd = -1;
    for (let i = buffer.length - 22; i >= eocdStart; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const entryCount = buffer.readUInt16LE(eocd + 10);
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    const entries: Array<{ name: string; method: number; compressedSize: number; localHeaderOffset: number }> = [];
    let cursor = cdOffset;
    for (let i = 0; i < entryCount; i += 1) {
        if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) return null;
        const method = buffer.readUInt16LE(cursor + 10);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
        entries.push({ name: buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength), method, compressedSize, localHeaderOffset });
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

export async function fetchConversationJson(page: PageLike, conversationId: string): Promise<ConversationJson | null> {
    return page.evaluate(async (convId: string) => {
        const session = await fetch('/api/auth/session').then(r => r.json()).catch(() => null);
        if (!session?.accessToken) return null;
        return fetch('/backend-api/conversation/' + convId, {
            headers: { Authorization: 'Bearer ' + session.accessToken },
        }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    }, conversationId);
}

export async function mintDownloadUrl(page: PageLike, params: { conversationId: string; messageId: string; sandboxPath: string }): Promise<string | null> {
    return page.evaluate(async (args: { conversationId: string; messageId: string; sandboxPath: string }) => {
        const session = await fetch('/api/auth/session').then(r => r.json()).catch(() => null);
        if (!session?.accessToken) return null;
        const url = '/backend-api/conversation/' + args.conversationId
            + '/interpreter/download?message_id=' + args.messageId
            + '&sandbox_path=' + encodeURIComponent(args.sandboxPath);
        const body = await fetch(url, { headers: { Authorization: 'Bearer ' + session.accessToken } })
            .then(r => (r.ok ? r.json() : null)).catch(() => null);
        return body?.download_url || null;
    }, params);
}

export async function fetchBinaryBase64(page: PageLike, url: string): Promise<{ status: number; base64: string } | null> {
    return page.evaluate(async (target: string) => {
        const response = await fetch(target, { credentials: 'include' }).catch(() => null);
        if (!response || !response.ok) return response ? { status: response.status, base64: '' } : null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
        }
        return { status: response.status, base64: btoa(binary) };
    }, url);
}

export async function retrieveCodeArtifact(page: PageLike, params: { conversationId: string; outputPath: string; requirePlan?: boolean }): Promise<RetrieveResult> {
    const result: RetrieveResult = { ok: false, reason: null, zipPath: null, savedPath: null, sizeBytes: 0, files: [] };
    const conversation = await fetchConversationJson(page, params.conversationId);
    if (!conversation) return { ...result, reason: 'code-artifact:conversation-unavailable' };
    const { zipPath, candidateMids } = scanConversationForZip(conversation);
    if (!zipPath) return { ...result, reason: 'code-artifact:missing' };
    if (!candidateMids.length) return { ...result, zipPath, reason: 'code-artifact:no-tool-messages' };
    return downloadAndSaveZip(page, { ...params, zipPath, candidateMids });
}

export async function retrieveAllCodeArtifacts(page: PageLike, params: { conversationId: string; outputDir: string; requirePlan?: boolean }): Promise<{ ok: boolean; reason: string | null; artifacts: RetrieveResult[] }> {
    const conversation = await fetchConversationJson(page, params.conversationId);
    if (!conversation) return { ok: false, reason: 'code-artifact:conversation-unavailable', artifacts: [] };
    const { zipPaths, candidateMids } = scanConversationForAllZips(conversation);
    if (!zipPaths.length) return { ok: false, reason: 'code-artifact:missing', artifacts: [] };
    if (!candidateMids.length) return { ok: false, reason: 'code-artifact:no-tool-messages', artifacts: [] };
    const artifacts: RetrieveResult[] = [];
    for (const zipPath of zipPaths) {
        // eslint-disable-next-line no-await-in-loop -- sequentially reuse one ChatGPT page.
        artifacts.push(await downloadAndSaveZip(page, { conversationId: params.conversationId, zipPath, candidateMids, outputPath: join(params.outputDir, basename(zipPath)), ...(params.requirePlan !== undefined ? { requirePlan: params.requirePlan } : {}) }));
    }
    const ok = artifacts.some(a => a.ok);
    return { ok, reason: ok ? null : 'code-artifact:all-failed', artifacts };
}

async function downloadAndSaveZip(page: PageLike, params: { conversationId: string; zipPath: string; candidateMids: string[]; outputPath: string; requirePlan?: boolean }): Promise<RetrieveResult> {
    const result: RetrieveResult = { ok: false, reason: null, zipPath: params.zipPath, savedPath: null, sizeBytes: 0, files: [], mintedMessageId: null };
    let payload: { status: number; base64: string } | null = null;
    let mintedMessageId: string | null = null;
    // Newest-first: when one conversation rebuilds the same sandbox path across
    // several code runs, interpreter/download serves the snapshot tied to the
    // message id — oldest-first minted a STALE artifact (drop10 incident,
    // 2026-06-11; mirrors agbrowse 02f03cc).
    for (const messageId of [...params.candidateMids].reverse()) {
        // eslint-disable-next-line no-await-in-loop
        const downloadUrl = await mintDownloadUrl(page, { conversationId: params.conversationId, messageId, sandboxPath: params.zipPath });
        if (!downloadUrl) continue;
        // eslint-disable-next-line no-await-in-loop
        const fetched = await fetchBinaryBase64(page, downloadUrl);
        if (fetched?.base64) { payload = fetched; mintedMessageId = messageId; break; }
    }
    if (!payload) return { ...result, reason: 'code-artifact:download-failed' };
    result.mintedMessageId = mintedMessageId;
    const buffer = Buffer.from(payload.base64, 'base64');
    const verified = verifyZipBuffer(buffer);
    if (!verified) return { ...result, sizeBytes: buffer.length, reason: 'code-artifact:invalid-zip' };
    const hasPlan = hasPlanArtifact(verified.files);
    if (params.requirePlan && !hasPlan) return { ...result, sizeBytes: buffer.length, files: verified.files, hasPlanArtifact: false, reason: 'code-artifact:plan-missing' };
    await mkdir(dirname(params.outputPath), { recursive: true });
    await writeFile(params.outputPath, buffer);
    return { ok: true, reason: null, zipPath: params.zipPath, savedPath: params.outputPath, sizeBytes: buffer.length, files: verified.files, hasPlanArtifact: hasPlan, mintedMessageId };
}
