/**
 * lib/upload.js — Phase 10
 * Media upload helpers: save files, build prompts, download Telegram files.
 * Pure I/O — no DB, no broadcast dependencies.
 */
import fs from 'fs';
import https from 'node:https';
import { join, extname, basename } from 'path';

/**
 * Save a buffer to ~/.cli-claw/uploads/ with a timestamped filename.
 * @param {string} uploadsDir - Absolute path to uploads directory
 * @param {Buffer} buffer - File content
 * @param {string} originalName - Original filename (for extension)
 * @returns {string} Absolute path to saved file
 */
export function saveUpload(uploadsDir, buffer, originalName) {
    const ts = Date.now();
    const ext = extname(originalName) || '.bin';
    const safeName = `${ts}_${basename(originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '')}${ext}`;
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
export function buildMediaPrompt(filePath, caption) {
    return `[사용자가 파일을 보냈습니다: ${filePath}]\n이 파일을 Read 도구로 읽고 분석해주세요.${caption ? `\n\n사용자 메시지: ${caption}` : ''}`;
}

/**
 * Download a file from Telegram servers using IPv4.
 * @param {string} fileId - Telegram file_id
 * @param {string} token - Bot token
 * @returns {Promise<{buffer: Buffer, ext: string, originalName: string}>}
 */
export function downloadTelegramFile(fileId, token) {
    return new Promise((resolve, reject) => {
        const getFileUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
        https.get(getFileUrl, { agent: new https.Agent({ family: 4 }) }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    const filePath = info.result?.file_path;
                    if (!filePath) return reject(new Error('getFile failed'));
                    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
                    https.get(fileUrl, { agent: new https.Agent({ family: 4 }) }, (fres) => {
                        const chunks = [];
                        fres.on('data', c => chunks.push(c));
                        fres.on('end', () => resolve({
                            buffer: Buffer.concat(chunks),
                            ext: extname(filePath) || '.jpg',
                            originalName: basename(filePath),
                        }));
                        fres.on('error', reject);
                    }).on('error', reject);
                } catch (e) { reject(e); }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}
