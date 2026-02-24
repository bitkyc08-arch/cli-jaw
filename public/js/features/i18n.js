// ── Frontend i18n module ──
// Phase 7: client-side translation with lazy-loaded locale JSON

let currentLocale = 'ko';
let dict = {};  // current locale dictionary
let fallbackDict = {};  // ko fallback

/**
 * Initialize i18n: restore from localStorage, detect from browser, load locale
 */
export async function initI18n() {
    let saved = null;
    try { saved = localStorage.getItem('claw_locale'); } catch { /* Safari private */ }

    if (!saved) {
        // Detect from browser language
        const browserLang = (navigator.language || 'ko').split(/[-_]/)[0].toLowerCase();
        saved = ['en', 'ko'].includes(browserLang) ? browserLang : 'ko';
    }

    // Always load ko as fallback
    fallbackDict = await fetchLocale('ko');
    if (saved === 'ko') {
        dict = fallbackDict;
    } else {
        dict = await fetchLocale(saved);
    }
    currentLocale = saved;
    applyI18n();
}

/**
 * Fetch a locale JSON from the server
 */
async function fetchLocale(lang) {
    try {
        const { api } = await import('../api.js');
        return await api(`/api/i18n/${lang}`) || {};
    } catch { return {}; }
}

/**
 * Translate a key with optional parameter interpolation
 * Falls back: dict[key] → fallbackDict[key] → key itself
 */
export function t(key, params = {}) {
    let val = dict[key] ?? fallbackDict[key] ?? key;
    for (const [k, v] of Object.entries(params)) {
        val = val.replaceAll(`{${k}}`, String(v));
    }
    return val;
}

/**
 * Apply translations to all elements with data-i18n attributes
 */
export function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) el.placeholder = t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) el.title = t(key);
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria');
        if (key) el.setAttribute('aria-label', t(key));
    });
}

/**
 * Switch language, reload locale, rebind all UI
 */
export async function setLang(lang) {
    if (lang === currentLocale) return;
    if (lang === 'ko') {
        dict = fallbackDict;
    } else {
        dict = await fetchLocale(lang);
    }
    currentLocale = lang;
    try { localStorage.setItem('claw_locale', lang); } catch { /* Safari private */ }
    applyI18n();

    // Reload dynamic content that uses t()
    try {
        const { loadEmployees } = await import('./employees.js');
        loadEmployees();
    } catch { }
    try {
        const { loadSkills } = await import('./skills.js');
        loadSkills();
    } catch { }
    try {
        const { loadCommands } = await import('./slash-commands.js');
        loadCommands();
    } catch { }
    try {
        const { loadSettings } = await import('./settings.js');
        loadSettings();
    } catch { }
}

/**
 * Get current locale code
 */
export function getLang() {
    return currentLocale;
}

/**
 * fetchWithLocale — wrapper that appends ?locale= to requests
 */
export function fetchWithLocale(url, init = {}) {
    const u = new URL(url, location.origin);
    if (!u.searchParams.has('locale')) {
        u.searchParams.set('locale', currentLocale);
    }
    return fetch(u.toString(), init);
}
