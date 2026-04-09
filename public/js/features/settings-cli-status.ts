// ── CLI Status & Quota ──
import { api } from '../api.js';
import { escapeHtml } from '../render.js';
import { t } from './i18n.js';
import { state } from '../state.js';
import type { QuotaEntry } from './settings-types.js';

export async function loadCliStatus(force = false): Promise<void> {
    const interval = Number(localStorage.getItem('cliStatusInterval') || 300);
    if (!force && state.cliStatusCache && interval > 0 && (Date.now() - state.cliStatusTs) < interval * 1000) {
        renderCliStatus({ cliStatus: (state.cliStatusCache as Record<string, unknown>)?.cliStatus as Record<string, { available: boolean }> | null, quota: (state.cliStatusCache as Record<string, unknown>)?.quota as Record<string, QuotaEntry> | null });
        return;
    }

    const el = document.getElementById('cliStatusList');
    if (el) el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Loading...</div>';

    const [cliStatus, quota] = await Promise.all([
        api<Record<string, { available: boolean }>>('/api/cli-status'),
        api<Record<string, QuotaEntry>>('/api/quota'),
    ]);

    state.cliStatusCache = { cliStatus, quota } as Record<string, unknown>;
    state.cliStatusTs = Date.now();
    renderCliStatus({ cliStatus, quota });
}

function renderCliStatus(data: { cliStatus: Record<string, { available: boolean }> | null; quota: Record<string, QuotaEntry> | null }): void {
    const { cliStatus, quota } = data;
    const el = document.getElementById('cliStatusList');

    const AUTH_HINTS: Record<string, { install: string; auth: string }> = {
        claude: { install: 'npm i -g @anthropic-ai/claude-code', auth: 'claude auth' },
        codex: { install: 'npm i -g @openai/codex', auth: 'codex login' },
        gemini: { install: 'npm i -g @google/gemini-cli', auth: `gemini  (${t('cli.gemini.auth')})` },
        opencode: { install: 'npm i -g opencode-ai', auth: 'opencode auth' },
        copilot: { install: 'npm i -g copilot', auth: 'copilot login 또는 gh auth login' },
    };

    let html = '';

    if (!cliStatus || typeof cliStatus !== 'object') {
        if (el) el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Failed to load CLI status</div>';
        return;
    }

    for (const [name, info] of Object.entries(cliStatus)) {
        const q = quota?.[name];
        let dotClass: string;
        if (!info.available) {
            dotClass = 'missing';
        } else if (!q || q.error) {
            dotClass = 'ok';
        } else if (q.authenticated === false) {
            dotClass = 'warn';
        } else {
            dotClass = 'ok';
        }

        let accountLine = '';
        if (q?.account) {
            const parts = [];
            if (q.account.email) parts.push(q.account.email);
            if (q.account.type) parts.push(q.account.type);
            if (q.account.plan) parts.push(q.account.plan);
            if (q.account.tier) parts.push(q.account.tier);
            if (parts.length) accountLine = `<div style="font-size:10px;color:var(--text-dim);margin:2px 0 4px 16px">${escapeHtml(parts.join(' · '))}</div>`;
        }

        let authHint = '';
        if (!info.available || dotClass === 'warn') {
            const hint = AUTH_HINTS[name];
            if (hint) {
                const isNotInstalled = !info.available;
                const title = isNotInstalled ? t('cli.authRequired') : t('cli.notAuthenticated');
                const borderColor = isNotInstalled ? '#ef4444' : '#fbbf24';
                authHint = `
                    <div style="font-size:10px;margin:4px 0 2px 16px;padding:6px 8px;background:var(--bg-dim, #1e1e2e);border-radius:4px;border-left:2px solid ${borderColor}">
                        <div style="color:${borderColor};margin-bottom:3px">${title}</div>
                        ${isNotInstalled ? `<div style="color:var(--text-dim)"><code style="font-size:10px;background:var(--border);padding:1px 4px;border-radius:2px">${escapeHtml(hint.install)}</code></div>` : ''}
                        <div style="color:var(--text-dim)${isNotInstalled ? ';margin-top:2px' : ''}"><code style="font-size:10px;background:var(--border);padding:1px 4px;border-radius:2px">${escapeHtml(hint.auth)}</code></div>
                    </div>
                `;
            }
        }

        let windowsHtml = '';
        if (q?.windows?.length) {
            windowsHtml = q.windows.map(w => {
                const pct = Math.round(w.percent);
                const barColor = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#38bdf8';
                const shortLabel = w.label.replace('-hour', 'h').replace('-day', 'd').replace(' Sonnet', '').replace(' Opus', '').replace('plus monthly subscriber quota', 'plus').replace('Premium', 'Prem');
                let resetStr = '';
                if (w.resetsAt) {
                    const d = new Date(typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : w.resetsAt);
                    const now = new Date();
                    if (d.toDateString() === now.toDateString()) {
                        resetStr = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
                    } else {
                        resetStr = `${d.getMonth() + 1}/${d.getDate()}`;
                    }
                }
                return `
                    <div style="display:flex;align-items:center;gap:4px;margin-left:16px;font-size:10px;color:var(--text-dim)">
                        <span style="min-width:18px;max-width:48px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(shortLabel)}</span>
                        <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
                            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px"></div>
                        </div>
                        <span style="width:24px;text-align:right">${pct}%</span>
                        ${resetStr ? `<span style="width:30px;text-align:right;opacity:0.6">${resetStr}</span>` : ''}
                    </div>
                `;
            }).join('');
        } else if (q?.error && info.available) {
            const msg = q.reason === 'rate_limited' ? 'Rate limited — retry in a moment' : 'Usage data unavailable';
            windowsHtml = `<div style="font-size:10px;color:var(--text-dim);margin:2px 0 0 16px;opacity:0.7">⚠ ${msg}</div>`;
        }

        html += `
            <div class="settings-group" style="margin-bottom:6px;padding:8px 10px">
                <div class="cli-status-row">
                    <span class="cli-dot ${dotClass}"></span>
                    <span class="cli-name" style="font-weight:600">${escapeHtml(name)}</span>${name === 'copilot' ? `<button id="copilotKeychainBtn" style="font-size:9px;margin-left:6px;padding:1px 5px;background:var(--border);color:var(--text-dim);border:1px solid var(--text-dim);border-radius:3px;cursor:pointer;vertical-align:middle;line-height:1" title="${t('copilot.keychainHint')}">🔑</button>` : ''}
                </div>
                ${accountLine}
                ${authHint}
                ${windowsHtml}
            </div>
        `;
    }

    if (el) el.innerHTML = html;

    const allEntries = Object.entries(cliStatus);
    const hasReadyCli = allEntries.some(([name, info]) => {
        if (!info.available) return false;
        const q = quota?.[name];
        return !q || q.authenticated !== false;
    });
    if (!hasReadyCli && allEntries.length > 0 && el) {
        el.insertAdjacentHTML('afterbegin',
            `<div style="padding:8px 10px;margin-bottom:8px;background:#fbbf2422;border:1px solid #fbbf24;border-radius:6px;font-size:11px;color:#fbbf24">
                ⚠ ${t('cli.noReadyCli')}
            </div>`
        );
    }

    const kcBtn = document.getElementById('copilotKeychainBtn');
    if (kcBtn) {
        kcBtn.addEventListener('click', async () => {
            const btn = kcBtn as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = '⏳';
            try {
                const res = await api<{ ok: boolean }>('/api/copilot/refresh', { method: 'POST' });
                btn.textContent = res?.ok ? '✅' : '❌';
                if (res?.ok) await loadCliStatus(true);
            } catch {
                btn.textContent = '❌';
            }
            setTimeout(() => { btn.textContent = '🔑'; btn.disabled = false; }, 2000);
        });
    }
}
