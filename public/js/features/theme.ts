// ── Theme Toggle ──
// Dark/Light theme switching with localStorage persistence
// hljs themes bundled via npm (no CDN dependency)

import githubDark from 'highlight.js/styles/github-dark.css?inline';
import githubLight from 'highlight.js/styles/github.css?inline';
import { broadcastThemeToIframes } from '../diagram/iframe-renderer.js';
import { rerenderMermaidDiagrams } from '../render.js';

const STORAGE_KEY = 'theme';
let hljsStyleEl: HTMLStyleElement | null = null;

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
    const saved = localStorage.getItem(STORAGE_KEY);
    const prefer = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    const theme = saved || prefer;
    applyTheme(theme);

    document.getElementById('toggleTheme')?.addEventListener('click', toggleTheme);
}

function toggleTheme(): void {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
}

function applyTheme(theme: string): void {
    document.documentElement.setAttribute('data-theme', theme);

    const btn = document.getElementById('toggleTheme');
    if (btn) {
        btn.classList.toggle('is-light', theme === 'light');
    }

    applyHljsTheme(theme);
    broadcastThemeToIframes();
    rerenderMermaidDiagrams();
}
