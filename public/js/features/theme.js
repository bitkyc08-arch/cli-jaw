// ── Theme Toggle ──
// Dark/Light theme switching with localStorage persistence
// Swaps CSS data-theme attribute + highlight.js stylesheet

const STORAGE_KEY = 'theme';
const HLJS_DARK = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css';
const HLJS_LIGHT = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css';

export function initTheme() {
    // Detect: localStorage → OS preference → default dark
    const saved = localStorage.getItem(STORAGE_KEY);
    const prefer = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    const theme = saved || prefer;
    applyTheme(theme);

    document.getElementById('toggleTheme')?.addEventListener('click', toggleTheme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);

    // Update button icon
    const btn = document.getElementById('toggleTheme');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';

    // Swap highlight.js theme
    const hljsLink = document.getElementById('hljsTheme');
    if (hljsLink) {
        hljsLink.href = theme === 'dark' ? HLJS_DARK : HLJS_LIGHT;
    }
}
