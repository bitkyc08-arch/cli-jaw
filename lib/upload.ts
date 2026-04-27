/**
 * lib/upload.js — Phase 10
 * Media upload helpers: save files, build prompts, download Telegram files.
 * Pure I/O — no DB, no broadcast dependencies.
 */
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { join, extname, basename } from 'path';

export const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 30_000;
export const TELEGRAM_METADATA_MAX_BYTES = 1024 * 1024;
export const TELEGRAM_DOWNLOAD_LIMITS = {
    voice: 50 * 1024 * 1024,
    photo: 10 * 1024 * 1024,
    document: 50 * 1024 * 1024,
} as const;

export type TelegramDownloadKind = keyof typeof TELEGRAM_DOWNLOAD_LIMITS;

export interface TelegramDownloadOptions {
    timeoutMs?: number;
    maxBytes?: number;
    fileSize?: number;
    kind?: TelegramDownloadKind;
}

/**
 * Save a buffer to ~/.cli-jaw/uploads/ with a timestamped filename.
 * @param {string} uploadsDir - Absolute path to uploads directory
 * @param {Buffer} buffer - File content
 * @param {string} originalName - Original filename (for extension)
 * @returns {string} Absolute path to saved file
 */
export function saveUpload(uploadsDir: string, buffer: Buffer, originalName: string) {
    const ts = Date.now();
    const ext = extname(originalName) || '.bin';
    const stem = basename(originalName, ext).replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 100) || 'file';
    const nonce = randomUUID().slice(0, 8);
    const safeName = `${ts}_${nonce}_${stem}${ext}`;
    const filePath = join(uploadsDir, safeName);
    fs.writeFileSync(filePath, buffer);
    console.log(`[upload] saved ${filePath} (${buffer.length} bytes)`);
    return filePath;
}

/**
 * Build a prompt that tells the agent a file was sent.
 * @param {string} filePath - Absolute path to the file
 * @param {string} [caption] - Optional user message
 * @returns {string} Prompt string
 */
export function buildMediaPrompt(filePath: string, caption?: string) {
    return `[사용자가 파일을 보냈습니다: ${filePath}]\n이 파일을 Read 도구로 읽고 분석해주세요.${caption ? `\n\n사용자 메시지: ${caption}` : ''}`;
}

export function buildMediaPromptMany(filePaths: string[], caption?: string) {
    const normalized = Array.from(new Set(filePaths.map(filePath => String(filePath).trim()).filter(Boolean)));
    if (normalized.length === 0) {
        throw new Error('buildMediaPromptMany requires at least one file path');
    }
    if (normalized.length === 1) {
        return buildMediaPrompt(normalized[0]!, caption);
    }

    const fileList = normalized.map((filePath, index) => `${index + 1}. ${filePath}`).join('\n');
    return `[사용자가 파일 ${normalized.length}개를 보냈습니다]\n${fileList}\n\n이 파일들을 모두 Read 도구로 읽고 비교 분석해주세요.${caption ? `\n\n사용자 메시지: ${caption}` : ''}`;
}

function assertTelegramDownloadSize(bytes: number | undefined, maxBytes: number | undefined, label: string): void {
    if (!Number.isFinite(bytes) || !maxBytes) return;
    if (Number(bytes) > maxBytes) {
        throw new Error(`Telegram ${label} too large: ${bytes} bytes exceeds ${maxBytes} bytes`);
    }
}

function readLimitedResponse(res: IncomingMessage, req: ReturnType<typeof https.get>, label: string, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            req.destroy(error);
            reject(error);
        };
        res.on('data', (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > maxBytes) {
                fail(new Error(`Telegram ${label} too large: exceeded ${maxBytes} bytes`));
                return;
            }
            chunks.push(buffer);
        });
        res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks, total));
        });
        res.on('error', fail);
    });
}

function telegramGet(url: string, label: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const req = https.get(url, { agent: new https.Agent({ family: 4 }) }, (res) => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
                res.resume();
                if (!settled) {
                    settled = true;
                    reject(new Error(`Telegram ${label} failed: HTTP ${status}`));
                }
                return;
            }
            readLimitedResponse(res, req, label, maxBytes).then(
                (buffer) => {
                    if (settled) return;
                    settled = true;
                    resolve(buffer);
                },
                (error: Error) => {
                    if (settled) return;
                    settled = true;
                    reject(error);
                },
            );
        });
        req.setTimeout(timeoutMs, () => {
            if (settled) return;
            settled = true;
            const error = new Error(`Telegram ${label} timed out after ${timeoutMs}ms`);
            req.destroy(error);
            reject(error);
        });
        req.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
    });
}

/**
 * Download a file from Telegram servers using IPv4.
 * @param {string} fileId - Telegram file_id
 * @param {string} token - Bot token
 * @returns {Promise<{buffer: Buffer, ext: string, originalName: string}>}
 */
export async function downloadTelegramFile(fileId: string, token: string, options: TelegramDownloadOptions = {}) {
    const timeoutMs = options.timeoutMs ?? TELEGRAM_DOWNLOAD_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? (options.kind ? TELEGRAM_DOWNLOAD_LIMITS[options.kind] : TELEGRAM_DOWNLOAD_LIMITS.document);
    assertTelegramDownloadSize(options.fileSize, maxBytes, options.kind || 'file');

    const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
    const metadataBuffer = await telegramGet(getFileUrl, 'getFile', timeoutMs, TELEGRAM_METADATA_MAX_BYTES);
    let info: Record<string, any>;
    try {
        info = JSON.parse(metadataBuffer.toString('utf8')) as Record<string, any>;
    } catch {
        throw new Error('Telegram getFile failed: invalid JSON');
    }

    const filePath = info.result?.file_path;
    if (info.ok === false || !filePath) throw new Error('Telegram getFile failed: missing file_path');
    assertTelegramDownloadSize(Number(info.result?.file_size), maxBytes, options.kind || 'file');

    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const buffer = await telegramGet(fileUrl, 'file download', timeoutMs, maxBytes);
    return {
        buffer,
        ext: extname(filePath) || '.jpg',
        originalName: basename(filePath),
    };
}

export const __test__ = {
    assertTelegramDownloadSize,
    telegramGet,
};
