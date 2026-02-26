// ── Frontend i18n module ──
// Phase 7: client-side translation with lazy-loaded locale JSON

type LocaleDict = Record<string, string>;

let currentLocale = 'ko';
let dict: LocaleDict = {};
let fallbackDict: LocaleDict = {};

/**
 * Initialize i18n: restore from localStorage, detect from browser, load locale
 */
export async function initI18n(): Promise<void> {
    let saved: string | null = null;
    try { saved = localStorage.getItem('claw_locale'); } catch { /* Safari private */ }

    if (!saved) {
        const browserLang = (navigator.language || 'ko').split(/[-_]/)[0].toLowerCase();
        saved = ['en', 'ko'].includes(browserLang) ? browserLang : 'ko';
    }

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
async function fetchLocale(lang: string): Promise<LocaleDict> {
    try {
        const { api } = await import('../api.js');
        return await api<LocaleDict>(`/api/i18n/${lang}`) || {};
    } catch { return {}; }
}

/**
 * Translate a key with optional parameter interpolation
 * Falls back: dict[key] → fallbackDict[key] → key itself
 */
export function t(key: string, params: Record<string, unknown> = {}): string {
    let val: string = dict[key] ?? fallbackDict[key] ?? key;
    for (const [k, v] of Object.entries(params)) {
        val = val.replaceAll(`{${k}}`, String(v));
    }
    return val;
}

/**
 * Apply translations to all elements with data-i18n attributes
 */
export function applyI18n(): void {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) (el as HTMLInputElement).placeholder = t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) (el as HTMLElement).title = t(key);
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria');
        if (key) el.setAttribute('aria-label', t(key));
    });
}

/**
 * Switch language, reload locale, rebind all UI
 */
export async function setLang(lang: string): Promise<void> {
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
    } catch { /* ignore */ }
    try {
        const { loadSkills } = await import('./skills.js');
        loadSkills();
    } catch { /* ignore */ }
    try {
        const { loadCommands } = await import('./slash-commands.js');
        loadCommands();
    } catch { /* ignore */ }
    try {
        const { loadSettings } = await import('./settings.js');
        loadSettings();
    } catch { /* ignore */ }
}

/**
 * Get current locale code
 */
export function getLang(): string {
    return currentLocale;
}

/**
 * fetchWithLocale — wrapper that appends ?locale= to requests
 */
export function fetchWithLocale(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url, location.origin);
    if (!u.searchParams.has('locale')) {
        u.searchParams.set('locale', currentLocale);
    }
    return fetch(u.toString(), init);
}
