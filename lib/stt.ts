/**
 * lib/stt.ts — Voice-to-text engine
 * Gemini REST API (primary) + mlx-whisper subprocess (fallback)
 * No external npm dependencies — uses Node built-in https + child_process.
 */
import fs from 'node:fs';
import https from 'node:https';
import { settings } from '../src/core/config.js';

export interface SttResult {
    text: string;
    engine: 'gemini' | 'whisper';
    elapsed: number;
}

function getSttSettings() {
    const stt = settings.stt || {};
    return {
        engine: stt.engine || 'auto',
        geminiApiKey: stt.geminiApiKey || process.env.GEMINI_API_KEY || '',
        geminiModel: stt.geminiModel || process.env.GEMINI_STT_MODEL || 'gemini-2.5-flash-lite',
        whisperModel: stt.whisperModel || 'mlx-community/whisper-large-v3-turbo',
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

    const body = JSON.stringify({
        contents: [{ parts: [
            { text: 'Transcribe this voice message accurately. Output ONLY the transcribed text, nothing else.' },
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
    const { engine, geminiApiKey } = getSttSettings();

    if (engine === 'whisper') {
        return await sttWhisper(audioPath);
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
