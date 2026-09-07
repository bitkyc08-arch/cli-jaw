// ── Theme Toggle ──
// Dark/Light theme switching with localStorage persistence
// hljs themes bundled via npm (no CDN dependency)

import githubDark from 'highlight.js/styles/github-dark.css?inline';
import githubLight from 'highlight.js/styles/github.css?inline';
import { broadcastThemeToIframes } from '../diagram/iframe-renderer.js';
import { rerenderMermaidDiagrams } from '../render.js';

const STORAGE_KEY = 'jaw.uiTheme';
let hljsStyleEl: HTMLStyleElement | null = null;
type ThemeValue = 'dark' | 'light' | 'auto';

function isThemeValue(value: unknown): value is ThemeValue {
    return value === 'dark' || value === 'light' || value === 'auto';
}

function resolveTheme(theme: string): 'dark' | 'light' {
    if (theme === 'light') return 'light';
    if (theme === 'auto' && typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    return 'dark';
}

function applyHljsTheme(theme: string): void {
    const css = theme === 'light' ? githubLight : githubDark;
    if (!hljsStyleEl) {
        hljsStyleEl = document.createElement('style');
        hljsStyleEl.id = 'hljsTheme';
        document.head.appendChild(hljsStyleEl);
    }
    hljsStyleEl.textContent = css;
}

export function initTheme(): void {
    if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem('theme')) {
        localStorage.setItem(STORAGE_KEY, localStorage.getItem('theme')!);
        localStorage.removeItem('theme');
    }

    const previewTheme = readPreviewThemeParam();
    const saved = localStorage.getItem(STORAGE_KEY);
    const prefer = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    const theme = previewTheme || saved || prefer;
    applyTheme(theme);

    document.getElementById('toggleTheme')?.addEventListener('click', toggleTheme);
    window.addEventListener('message', handlePreviewThemeMessage);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', () => {
        const current = localStorage.getItem(STORAGE_KEY);
        if (!current || current === 'auto') {
            applyTheme(current || 'auto');
        }
    });

    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY && e.newValue) {
            applyTheme(e.newValue);
        }
    });
}

function toggleTheme(): void {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
}

function applyTheme(theme: string): void {
    const resolved = resolveTheme(theme);
    // Shell tokens, including light overrides, live in public/css/variables.css.
    document.documentElement.setAttribute('data-theme', resolved);

    const btn = document.getElementById('toggleTheme');
    if (btn) {
        btn.classList.toggle('is-light', resolved === 'light');
    }

    applyHljsTheme(resolved);
    broadcastThemeToIframes();
    rerenderMermaidDiagrams();
}

function readPreviewThemeParam(): ThemeValue | null {
    const value = new URLSearchParams(window.location.search).get('jawTheme');
    return isThemeValue(value) ? value : null;
}

function isLocalThemeOrigin(origin: string): boolean {
    if (origin === window.location.origin) return true;
    try {
        const hostname = new URL(origin).hostname;
        return hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname === '[::1]';
    } catch {
        return false;
    }
}

function handlePreviewThemeMessage(event: MessageEvent): void {
    if (window.parent === window) return;
    if (event.source !== window.parent) return;
    if (!isLocalThemeOrigin(event.origin)) return;
    const data = event.data as { type?: unknown; theme?: unknown } | null;
    if (!data || data.type !== 'jaw-preview-theme-sync' || !isThemeValue(data.theme)) return;
    applyTheme(data.theme);
}
