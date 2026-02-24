// ─── Server-side i18n Module (Phase 6.9) ─────────────
// Shared t() function for commands, telegram, CLI, and server routes.

import fs from 'fs';
import { join } from 'path';

const locales = {};

/**
 * Load all locale JSON files from the given directory.
 * Ignores files prefixed with 'skills-' (handled separately).
 */
export function loadLocales(localeDir) {
    if (!fs.existsSync(localeDir)) return;
    for (const f of fs.readdirSync(localeDir).filter(f => f.endsWith('.json') && !f.startsWith('skills-'))) {
        try {
            const lang = f.replace('.json', '');
            locales[lang] = JSON.parse(fs.readFileSync(join(localeDir, f), 'utf8'));
        } catch (err) {
            console.warn(`[i18n] failed to load ${f}:`, err.message);
        }
    }
}

/**
 * Translate a key with optional parameter interpolation.
 * Falls back to ko locale, then to the key itself.
 *
 * @param {string} key - Dot-separated key (e.g. 'cmd.help.desc')
 * @param {Object} params - Values for {placeholder} interpolation
 * @param {string} lang - Target locale code ('ko', 'en', etc.)
 * @returns {string}
 */
export function t(key, params = {}, lang = 'ko') {
    const dict = locales[lang] || locales['ko'] || {};
    let val = dict[key] ?? key;
    for (const [k, v] of Object.entries(params)) {
        val = val.replaceAll(`{${k}}`, String(v));
    }
    return val;
}

/**
 * Get list of available locale codes.
 * @returns {string[]}
 */
export function getAvailableLocales() {
    return Object.keys(locales);
}

// ─── Prompt Locale (A-2.md Language field) ───────────

const LANG_NORMALIZE = {
    'korean': 'ko', '한국어': 'ko', 'ko': 'ko',
    'english': 'en', '영어': 'en', 'en': 'en',
    'japanese': 'ja', '일본어': 'ja', 'ja': 'ja',
    'chinese': 'zh', '중국어': 'zh', 'zh': 'zh',
};

/**
 * Parse the Language field from A-2.md and normalize to a locale code.
 * Falls back to 'ko' if not found or unrecognized.
 *
 * @param {string} a2Path - Absolute path to A-2.md
 * @returns {string} Locale code
 */
export function getPromptLocale(a2Path) {
    try {
        const a2 = fs.existsSync(a2Path) ? fs.readFileSync(a2Path, 'utf8') : '';
        const match = a2.match(/Language\s*[:：]\s*(.+)/i);
        const raw = (match?.[1] || '').trim().toLowerCase();
        return LANG_NORMALIZE[raw] || 'ko';
    } catch {
        return 'ko';
    }
}
