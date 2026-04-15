// ── Web Locale Helpers ──

const LOCALE_KEYS: string[] = ['claw_locale', 'claw.locale'];

export function getPreferredLocale(): string {
    try {
        for (const key of LOCALE_KEYS) {
            const saved = localStorage.getItem(key);
            if (saved) return saved;
        }
    } catch { }
    return navigator.language || 'ko';
}

export function syncStoredLocale(locale: string): void {
    const value = String(locale || '').trim();
    if (!value) return;
    try {
        for (const key of LOCALE_KEYS) {
            localStorage.setItem(key, value);
        }
    } catch { }
}

// ── Translation Map ──
type Lang = 'ko' | 'en';

const STRINGS: Record<string, Record<Lang, string>> = {
    devMode:           { ko: '개발자 모드',   en: 'Developer Mode' },
    devModeOn:         { ko: '개발자 모드 ON', en: 'Developer Mode ON' },
    promptEditWarning: {
        ko: '⚠ 프롬프트를 직접 수정하면 예상치 못한 동작이 발생할 수 있습니다.\n계속하시겠습니까?',
        en: '⚠ Editing prompts directly may cause unexpected behavior.\nContinue?'
    },
    savedAndReloaded:  { ko: '저장 + 핫리로드 완료!', en: 'Saved + Hot Reloaded!' },
    promptStructure:   { ko: '프롬프트 구조',  en: 'Prompt Structure' },
    updateNeeded:      { ko: '업데이트 필요',  en: 'Update Needed' },
    memoryUpdating:    { ko: '메모리 구조를 업데이트하는 중...', en: 'Upgrading memory structure...' },
    memoryUpdateBtn:   { ko: '메모리 업데이트하기', en: 'Update Memory' },
};

function detectLang(): Lang {
    const pref = getPreferredLocale();
    return pref.startsWith('ko') ? 'ko' : 'en';
}

let _lang: Lang = detectLang();

export function setLang(lang: Lang) { _lang = lang; syncStoredLocale(lang); }
export function getLang(): Lang { return _lang; }
export function t(key: string): string {
    return STRINGS[key]?.[_lang] ?? STRINGS[key]?.['en'] ?? key;
}
