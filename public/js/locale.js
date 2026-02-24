// ── Web Locale Helpers ──

const LOCALE_KEYS = ['claw_locale', 'claw.locale'];

export function getPreferredLocale() {
    try {
        for (const key of LOCALE_KEYS) {
            const saved = localStorage.getItem(key);
            if (saved) return saved;
        }
    } catch { }
    return navigator.language || 'ko';
}

export function syncStoredLocale(locale) {
    const value = String(locale || '').trim();
    if (!value) return;
    try {
        for (const key of LOCALE_KEYS) {
            localStorage.setItem(key, value);
        }
    } catch { }
}
