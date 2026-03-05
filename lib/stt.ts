/**
 * lib/stt.ts — Voice-to-text engine
 * Gemini REST API (primary) + mlx-whisper subprocess (fallback)
 * No external npm dependencies — uses Node built-in https + child_process.
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { settings } from '../src/core/config.js';

export interface SttResult {
    text: string;
    engine: 'gemini' | 'whisper' | 'openai' | 'vertex';
    elapsed: number;
}

function getSttSettings() {
    const stt = settings.stt || {};
    return {
        engine: stt.engine || 'auto',
        geminiApiKey: stt.geminiApiKey || process.env.GEMINI_API_KEY || '',
        geminiModel: stt.geminiModel || process.env.GEMINI_STT_MODEL || 'gemini-2.5-flash-lite',
        whisperModel: stt.whisperModel || 'mlx-community/whisper-large-v3-turbo',
        openaiBaseUrl: stt.openaiBaseUrl || '',
        openaiApiKey: stt.openaiApiKey || '',
        openaiModel: stt.openaiModel || '',
        vertexConfig: stt.vertexConfig || '',
    };
}

/**
 * Gemini STT via REST API (no SDK dependency).
 * POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 */
export async function sttGemini(audioPath: string, mimeType = 'audio/ogg'): Promise<SttResult> {
    const { geminiApiKey: apiKey, geminiModel: model } = getSttSettings();
    if (!apiKey) throw new Error('GEMINI_API_KEY not set (settings.json or env)');

    const audioB64 = fs.readFileSync(audioPath).toString('base64');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const __sttDir = path.dirname(fileURLToPath(import.meta.url));
    const sttPrompt = fs.readFileSync(path.join(__sttDir, '..', 'prompts', 'stt-system.md'), 'utf8').trim();
    const body = JSON.stringify({
        contents: [{ parts: [
            { text: sttPrompt },
            { inline_data: { mime_type: mimeType, data: audioB64 } },
        ] }],
    });

    const t0 = Date.now();
    const text = await new Promise<string>((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 30_000,
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        return reject(new Error(`Gemini API ${res.statusCode}: ${data.slice(0, 200)}`));
                    }
                    const json = JSON.parse(data);
                    const t = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    if (!t) return reject(new Error('Gemini returned empty transcription'));
                    resolve(t.trim());
                } catch (e) { reject(new Error(`Gemini parse error: ${data.slice(0, 200)}`)); }
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('Gemini API timeout (30s)'));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });

    return { text, engine: 'gemini', elapsed: (Date.now() - t0) / 1000 };
}

/**
 * OpenAI-compatible STT endpoint (Groq, local whisper servers, etc.)
 * Sends multipart/form-data to {baseUrl}/v1/audio/transcriptions
 */
export async function sttOpenaiCompatible(audioPath: string, mimeType = 'audio/ogg'): Promise<SttResult> {
    const { openaiBaseUrl, openaiApiKey, openaiModel } = getSttSettings();
    if (!openaiBaseUrl || !openaiApiKey) throw new Error('OpenAI Compatible: base URL and API key required');
    const url = `${openaiBaseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`;
    const boundary = '----FormBoundary' + Date.now();
    const fileData = fs.readFileSync(audioPath);
    const ext = mimeType.includes('mp4') ? 'audio.m4a' : mimeType.includes('ogg') ? 'audio.ogg' : 'audio.webm';
    const part0 = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const part1 = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${openaiModel || 'whisper-1'}`;
    const part2 = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext`;
    const part3 = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(part0), fileData, Buffer.from(part1), Buffer.from(part2), Buffer.from(part3)]);
    const t0 = Date.now();
    const parsed = new URL(url);
    const httpMod = parsed.protocol === 'https:' ? https : (await import('node:http')).default;
    const text = await new Promise<string>((resolve, reject) => {
        const req = httpMod.request(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
            timeout: 60_000,
        }, (res) => {
            let data = ''; res.on('data', (c: Buffer | string) => data += c);
            res.on('end', () => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) return reject(new Error(`OpenAI API ${res.statusCode}: ${data.slice(0, 200)}`));
                resolve(data.trim());
            });
        });
        req.on('timeout', () => req.destroy(new Error('OpenAI Compatible API timeout (60s)')));
        req.on('error', reject);
        req.write(body); req.end();
    });
    return { text, engine: 'openai', elapsed: (Date.now() - t0) / 1000 };
}

/**
 * Vertex AI STT — uses Gemini API format with JSON service account auth.
 * Config is a JSON string: { endpoint, token?, model? }
 */
export async function sttVertex(audioPath: string, mimeType = 'audio/ogg'): Promise<SttResult> {
    const { vertexConfig: configStr } = getSttSettings();
    if (!configStr) throw new Error('Vertex AI: config JSON not set');
    let config: { endpoint: string; token?: string; model?: string };
    try { config = JSON.parse(configStr); } catch { throw new Error('Vertex AI: invalid JSON config'); }
    if (!config.endpoint) throw new Error('Vertex AI: endpoint required in config');
    const audioB64 = fs.readFileSync(audioPath).toString('base64');
    const reqBody = JSON.stringify({ audio: audioB64, mime_type: mimeType, model: config.model });
    const t0 = Date.now();
    const parsed = new URL(config.endpoint);
    const httpMod = parsed.protocol === 'https:' ? https : (await import('node:http')).default;
    const text = await new Promise<string>((resolve, reject) => {
        const req = httpMod.request(config.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(config.token ? { 'Authorization': `Bearer ${config.token}` } : {}) },
            timeout: 60_000,
        }, (res) => {
            let data = ''; res.on('data', (c: Buffer | string) => data += c);
            res.on('end', () => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) return reject(new Error(`Vertex AI ${res.statusCode}: ${data.slice(0, 200)}`));
                try { resolve(JSON.parse(data).text || data.trim()); } catch { resolve(data.trim()); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Vertex AI timeout (60s)')));
        req.on('error', reject);
        req.write(reqBody); req.end();
    });
    return { text, engine: 'vertex', elapsed: (Date.now() - t0) / 1000 };
}

/**
 * Local whisper fallback via Python subprocess.
 * Uses execFileSync with argv separation (no shell injection risk).
 */
export async function sttWhisper(audioPath: string): Promise<SttResult> {
    const { whisperModel } = getSttSettings();
    const { execFileSync } = await import('node:child_process');
    const t0 = Date.now();
    const script = `
import sys, json
import mlx_whisper
r = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=sys.argv[2])
print(json.dumps({'text': r.get('text','')}))
`;
    const out = execFileSync('python3', ['-c', script, audioPath, whisperModel], { timeout: 60_000 }).toString().trim();
    const text = JSON.parse(out).text || '';
    return { text, engine: 'whisper', elapsed: (Date.now() - t0) / 1000 };
}

/**
 * Main entry: engine setting controls priority.
 * auto = Gemini → Whisper fallback (default)
 * gemini = Gemini only (no fallback)
 * whisper = Whisper only (skip Gemini)
 */
export async function transcribeVoice(audioPath: string, mimeType = 'audio/ogg'): Promise<SttResult> {
    const { engine, geminiApiKey, openaiApiKey, vertexConfig } = getSttSettings();
    console.log(`[stt] engine=${engine}, geminiKeySet=${!!geminiApiKey}, openaiKeySet=${!!openaiApiKey}, file=${audioPath}`);

    if (engine === 'whisper') {
        return await sttWhisper(audioPath);
    }
    if (engine === 'openai') {
        return await sttOpenaiCompatible(audioPath, mimeType);
    }
    if (engine === 'vertex') {
        return await sttVertex(audioPath, mimeType);
    }
    if (engine === 'gemini' || (engine === 'auto' && geminiApiKey)) {
        try { return await sttGemini(audioPath, mimeType); }
        catch (e: any) {
            if (engine === 'gemini') throw e;
            console.warn('[stt] Gemini failed, trying whisper:', e.message);
        }
    }
    try { return await sttWhisper(audioPath); }
    catch (e: any) { throw new Error(`STT failed: ${e.message}`); }
}
