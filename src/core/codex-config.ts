// ─── Codex config.toml Sync ──────────────────────────
// Inject/remove model_context_window and model_auto_compact_token_limit
// into ~/.codex/config.toml when the 1M Context toggle changes.

import os from 'os';
import fs from 'fs';
import { join } from 'path';
import { log } from './logger.js';

const CODEX_CONFIG = join(os.homedir(), '.codex', 'config.toml');

interface ContextWindowConfig {
    enabled: boolean;
    contextWindow?: number;
    compactLimit?: number;
}

const KEYS = ['model_context_window', 'model_auto_compact_token_limit'] as const;

/**
 * Sync context window settings to ~/.codex/config.toml.
 * - enabled=true  → upsert both keys with provided values
 * - enabled=false → remove both keys
 */
export function syncCodexContextWindow(cfg: ContextWindowConfig): void {
    const dir = join(os.homedir(), '.codex');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let content = '';
    try { content = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { /* file may not exist */ }

    const windowVal = cfg.contextWindow ?? 1000000;
    const compactVal = cfg.compactLimit ?? 900000;

    // Remove existing lines for both keys
    const lines = content.split('\n');
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        return !KEYS.some(k => trimmed.startsWith(k + ' ') || trimmed.startsWith(k + '='));
    });

    if (cfg.enabled) {
        // Insert after last root key (before first [table])
        const firstTableIdx = filtered.findIndex(l => /^\s*\[/.test(l));
        const insertIdx = firstTableIdx === -1 ? filtered.length : firstTableIdx;

        // Find the right insert point — after existing root keys, before first blank before table
        const newLines = [
            `model_context_window = ${windowVal}`,
            `model_auto_compact_token_limit = ${compactVal}`,
        ];

        filtered.splice(insertIdx, 0, ...newLines);
    }

    // Clean up double blank lines
    const result = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(CODEX_CONFIG, result);
    log.info(`[codex-config] context window ${cfg.enabled ? `ON (${windowVal}/${compactVal})` : 'OFF'}`);
}

/**
 * Read current context window state from config.toml.
 */
export function readCodexContextWindow(): ContextWindowConfig {
    try {
        const content = fs.readFileSync(CODEX_CONFIG, 'utf8');
        const windowMatch = content.match(/^model_context_window\s*=\s*(\d+)/m);
        const compactMatch = content.match(/^model_auto_compact_token_limit\s*=\s*(\d+)/m);
        if (windowMatch) {
            return {
                enabled: true,
                contextWindow: parseInt(windowMatch[1] || '1000000', 10),
                compactLimit: compactMatch ? parseInt(compactMatch[1] || '900000', 10) : 900000,
            };
        }
    } catch { /* file may not exist */ }
    return { enabled: false };
}

/** Read only the root openai_base_url, never a same-named key inside a TOML table. */
export function readCodexRootOpenAiBaseUrl(content?: string): string | null {
    let source = content;
    if (source === undefined) {
        try { source = fs.readFileSync(CODEX_CONFIG, 'utf8'); }
        catch { return null; }
    }
    const root = source.split('\n').filter((line) => !/^\s*\[/.test(line));
    const firstTableIndex = source.split('\n').findIndex((line) => /^\s*\[/.test(line));
    const rootLines = firstTableIndex < 0 ? root : source.split('\n').slice(0, firstTableIndex);
    for (const line of rootLines) {
        const match = line.match(/^\s*openai_base_url\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/);
        if (match?.[2]) return match[2];
    }
    return null;
}
