// ── Settings Feature ──
import { MODEL_MAP, loadCliRegistry, getCliKeys, getCliMeta } from '../constants.js';
import { escapeHtml } from '../render.js';

function toCap(cli) {
    return cli.charAt(0).toUpperCase() + cli.slice(1);
}

function getModelSelect(cli) {
    return document.getElementById('model' + toCap(cli));
}

function getCustomModelInput(cli) {
    return document.getElementById('customModel' + toCap(cli));
}

function getEffortSelect(cli) {
    return document.getElementById('effort' + toCap(cli));
}

function setSelectOptions(selectEl, values, { includeCustom = false, includeDefault = false, selected = '' } = {}) {
    if (!selectEl) return;
    const defaultHtml = includeDefault ? '<option value="default">default</option>' : '';
    const customHtml = includeCustom ? '<option value="__custom__">✏️ 직접 입력...</option>' : '';
    const opts = (values || []).map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    selectEl.innerHTML = defaultHtml + opts + customHtml;

    if (selected && Array.from(selectEl.options).some(o => o.value === selected)) {
        selectEl.value = selected;
    }
}

function appendCustomOption(selectEl, value) {
    if (!selectEl || !value) return;
    if (Array.from(selectEl.options).some(o => o.value === value)) return;
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    const customOpt = selectEl.querySelector('option[value="__custom__"]');
    if (customOpt) selectEl.insertBefore(opt, customOpt);
    else selectEl.appendChild(opt);
}

function syncCliOptionSelects(settings = null) {
    const cliKeys = getCliKeys();

    const selCli = document.getElementById('selCli');
    if (selCli) {
        const current = settings?.cli || selCli.value || cliKeys[0] || 'claude';
        selCli.innerHTML = cliKeys.map(cli => {
            const label = getCliMeta(cli)?.label || cli;
            return `<option value="${escapeHtml(cli)}">${escapeHtml(label)}</option>`;
        }).join('');
        if (Array.from(selCli.options).some(o => o.value === current)) selCli.value = current;
    }

    const memCli = document.getElementById('memCli');
    if (memCli) {
        const current = settings?.memory?.cli || memCli.value || '';
        memCli.innerHTML = '<option value="">(active CLI)</option>' +
            cliKeys.map(cli => `<option value="${escapeHtml(cli)}">${escapeHtml(cli)}</option>`).join('');
        if (Array.from(memCli.options).some(o => o.value === current)) memCli.value = current;
    }
}

function syncPerCliModelAndEffortControls(settings = null) {
    for (const cli of getCliKeys()) {
        const modelSel = getModelSelect(cli);
        if (modelSel) {
            const selected = settings?.perCli?.[cli]?.model || modelSel.value || '';
            setSelectOptions(modelSel, MODEL_MAP[cli] || [], { includeCustom: true, includeDefault: true, selected });
            if (selected && !Array.from(modelSel.options).some(o => o.value === selected)) {
                appendCustomOption(modelSel, selected);
                modelSel.value = selected;
            }
        }

        const effortSel = getEffortSelect(cli);
        if (effortSel) {
            const meta = getCliMeta(cli);
            const options = [''].concat(meta?.efforts || []);
            const selected = settings?.perCli?.[cli]?.effort || effortSel.value || '';
            const unique = [...new Set(options)];
            effortSel.innerHTML = unique.map(v => {
                if (!v) return '<option value="">— none</option>';
                return `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
            }).join('');
            if (Array.from(effortSel.options).some(o => o.value === selected)) effortSel.value = selected;
        }
    }
}

function syncActiveEffortOptions(cli, selected = '') {
    const selEffort = document.getElementById('selEffort');
    if (!selEffort) return;
    const efforts = [''].concat(getCliMeta(cli)?.efforts || []);
    const unique = [...new Set(efforts)];
    selEffort.innerHTML = unique.map(v => {
        if (!v) return '<option value="">— none</option>';
        return `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
    }).join('');
    if (Array.from(selEffort.options).some(o => o.value === selected)) selEffort.value = selected;
}

export async function loadSettings() {
    await loadCliRegistry();
    const s = await (await fetch('/api/settings')).json();
    syncCliOptionSelects(s);
    syncPerCliModelAndEffortControls(s);

    const selCli = document.getElementById('selCli');
    if (Array.from(selCli.options).some(o => o.value === s.cli)) {
        selCli.value = s.cli;
    }
    document.getElementById('inpCwd').value = s.workingDir;
    document.getElementById('headerCli').textContent = s.cli;
    setPerm(s.permissions, false);

    if (s.perCli) {
        for (const [cli, cfg] of Object.entries(s.perCli)) {
            const modelEl = getModelSelect(cli);
            const effortEl = getEffortSelect(cli);
            if (modelEl && cfg.model) {
                appendCustomOption(modelEl, cfg.model);
                modelEl.value = cfg.model;
            }
            if (effortEl) effortEl.value = cfg.effort || '';
        }
    }

    onCliChange(false);
    const activeCfg = s.perCli?.[s.cli] || {};
    if (activeCfg.model) document.getElementById('selModel').value = activeCfg.model;
    syncActiveEffortOptions(s.cli, activeCfg.effort || '');

    loadTelegramSettings(s);
    loadFallbackOrder(s);
    loadMcpServers();
}

export async function loadMcpServers() {
    try {
        const d = await (await fetch('/api/mcp')).json();
        const el = document.getElementById('mcpServerList');
        const names = Object.entries(d.servers || {});
        if (!names.length) { el.textContent = '(no servers configured)'; return; }
        el.innerHTML = names.map(([n, s]) =>
            `<div style="padding:2px 0">• <b>${n}</b> <span style="opacity:.6">${s.command} ${(s.args || []).slice(0, 2).join(' ')}</span></div>`
        ).join('');
    } catch { }
}

export async function syncMcpServers() {
    const resultEl = document.getElementById('mcpSyncResult');
    resultEl.style.display = 'block';
    resultEl.textContent = '동기화 중...';
    try {
        const d = await (await fetch('/api/mcp/sync', { method: 'POST' })).json();
        const r = d.results || {};
        resultEl.innerHTML = Object.entries(r).map(([k, v]) =>
            `${v ? '✅' : '⏭️'} ${k}`
        ).join(' &nbsp; ');
    } catch (e) { resultEl.textContent = '❌ ' + e.message; }
}

export async function installMcpGlobal() {
    const resultEl = document.getElementById('mcpSyncResult');
    resultEl.style.display = 'block';
    resultEl.textContent = '📦 npm i -g 설치 중... (최대 2분 소요)';
    try {
        const d = await (await fetch('/api/mcp/install', { method: 'POST' })).json();
        resultEl.innerHTML = Object.entries(d.results || {}).map(([k, v]) => {
            const icon = v.status === 'installed' ? '✅' : v.status === 'skip' ? '⏭️' : '❌';
            return `${icon} <b>${k}</b>: ${v.status}${v.bin ? ' → ' + v.bin : ''}`;
        }).join('<br>');
        loadMcpServers();
    } catch (e) { resultEl.textContent = '❌ ' + e.message; }
}

export async function updateSettings() {
    const s = {
        cli: document.getElementById('selCli').value,
        workingDir: document.getElementById('inpCwd').value,
    };
    document.getElementById('headerCli').textContent = s.cli;
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
    });
}

export function setPerm(p, save = true) {
    document.getElementById('permSafe').classList.toggle('active', p === 'safe');
    document.getElementById('permAuto').classList.toggle('active', p === 'auto');
    if (save) fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: p }),
    });
}

export function getModelValue(cli) {
    const sel = getModelSelect(cli);
    if (!sel) return 'default';
    if (sel.value === '__custom__') {
        const inp = getCustomModelInput(cli);
        return inp?.value?.trim() || sel.options[0]?.value || 'default';
    }
    return sel.value;
}

export function handleModelSelect(cli, selectEl) {
    const customInput = getCustomModelInput(cli);
    if (!customInput) return;
    if (selectEl.value === '__custom__') {
        customInput.style.display = 'block';
        customInput.focus();
    } else {
        customInput.style.display = 'none';
        savePerCli();
    }
}

export function applyCustomModel(cli, inputEl) {
    const val = inputEl.value.trim();
    if (!val) return;
    const select = getModelSelect(cli);
    if (!select) return;
    appendCustomOption(select, val);
    select.value = val;
    inputEl.style.display = 'none';
    savePerCli();
}

export async function savePerCli() {
    const perCli = {};
    for (const cli of getCliKeys()) {
        const modelEl = getModelSelect(cli);
        if (!modelEl) continue;
        const effortEl = getEffortSelect(cli);
        perCli[cli] = {
            model: getModelValue(cli),
            effort: effortEl ? effortEl.value : '',
        };
    }
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perCli }),
    });
}

export function onCliChange(save = true) {
    const cli = document.getElementById('selCli').value;
    const models = MODEL_MAP[cli] || [];
    const modelSel = document.getElementById('selModel');
    setSelectOptions(modelSel, models, { includeCustom: true, includeDefault: true });
    document.getElementById('headerCli').textContent = cli;
    syncActiveEffortOptions(cli);

    const oldInput = document.getElementById('selModelCustom');
    if (oldInput) oldInput.remove();
    const inp = document.createElement('input');
    inp.type = 'text'; inp.id = 'selModelCustom';
    inp.className = 'custom-model-input';
    inp.placeholder = 'model ID 입력';
    inp.style.display = 'none';
    inp.onchange = function () {
        const val = this.value.trim();
        if (!val) return;
        appendCustomOption(modelSel, val);
        modelSel.value = val;
        this.style.display = 'none';
        saveActiveCliSettings();
    };
    modelSel.parentElement.appendChild(inp);
    modelSel.onchange = function () {
        if (this.value === '__custom__') {
            inp.style.display = 'block';
            inp.focus();
        } else {
            inp.style.display = 'none';
            saveActiveCliSettings();
        }
    };

    fetch('/api/settings').then(r => r.json()).then(s => {
        const cfg = s.perCli?.[cli] || {};
        if (cfg.model) {
            appendCustomOption(modelSel, cfg.model);
            modelSel.value = cfg.model;
        }
        syncActiveEffortOptions(cli, cfg.effort || '');
    });

    if (save) updateSettings();
}

export async function saveActiveCliSettings() {
    const cli = document.getElementById('selCli').value;
    const modelSel = document.getElementById('selModel');
    let model = modelSel?.value || 'default';
    if (model === '__custom__') {
        model = document.getElementById('selModelCustom')?.value?.trim() || 'default';
    }
    const perCli = {};
    perCli[cli] = {
        model,
        effort: document.getElementById('selEffort').value,
    };
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perCli }),
    });
}

// ── Telegram ──
export async function saveTelegramSettings() {
    const token = document.getElementById('tgToken').value.trim();
    const chatIdsRaw = document.getElementById('tgChatIds').value.trim();
    const allowedChatIds = chatIdsRaw
        ? chatIdsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
        : [];
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram: { token, allowedChatIds } }),
    });
}

export async function setTelegram(enabled) {
    document.getElementById('tgOn').classList.toggle('active', enabled);
    document.getElementById('tgOff').classList.toggle('active', !enabled);
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram: { enabled } }),
    });
}

function loadTelegramSettings(s) {
    if (!s.telegram) return;
    const tg = s.telegram;
    document.getElementById('tgOn').classList.toggle('active', !!tg.enabled);
    document.getElementById('tgOff').classList.toggle('active', !tg.enabled);
    if (tg.token) document.getElementById('tgToken').value = tg.token;
    if (tg.allowedChatIds?.length) {
        document.getElementById('tgChatIds').value = tg.allowedChatIds.join(', ');
    }
}

// ── Fallback Order ──
export function loadFallbackOrder(s) {
    const container = document.getElementById('fallbackOrderList');
    if (!container) return;
    const allClis = Object.keys(s.perCli || {});
    const active = s.fallbackOrder || [];
    const slotCount = Math.min(allClis.length - 1, 3);

    let html = '';
    for (let i = 0; i < slotCount; i++) {
        const current = active[i] || '';
        const opts = allClis.map(cli =>
            `<option value="${cli}" ${cli === current ? 'selected' : ''}>${cli}</option>`
        ).join('');
        html += `
            <div class="settings-row sub-row">
                <label style="min-width:60px">Fallback ${i + 1}</label>
                <select id="fallback${i}"
                    style="font-size:11px;padding:4px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;flex:1">
                    <option value="">(없음)</option>
                    ${opts}
                </select>
            </div>`;
    }
    container.innerHTML = html;
}

export async function saveFallbackOrder() {
    const selects = document.querySelectorAll('#fallbackOrderList select');
    const fallbackOrder = [...selects].map(s => s.value).filter(Boolean);
    await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fallbackOrder }),
    });
}

// ── CLI Status ──
import { state } from '../state.js';

export async function loadCliStatus(force = false) {
    const interval = Number(localStorage.getItem('cliStatusInterval') || 300);
    if (!force && state.cliStatusCache && interval > 0 && (Date.now() - state.cliStatusTs) < interval * 1000) {
        renderCliStatus(state.cliStatusCache);
        return;
    }

    const el = document.getElementById('cliStatusList');
    el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">Loading...</div>';

    const [cliStatus, quota] = await Promise.all([
        (await fetch('/api/cli-status')).json(),
        (await fetch('/api/quota')).json(),
    ]);

    state.cliStatusCache = { cliStatus, quota };
    state.cliStatusTs = Date.now();
    renderCliStatus(state.cliStatusCache);
}

function renderCliStatus(data) {
    const { cliStatus, quota } = data;
    const el = document.getElementById('cliStatusList');
    let html = '';

    for (const [name, info] of Object.entries(cliStatus)) {
        const q = quota[name];
        const dotClass = info.available ? 'ok' : 'missing';

        let accountLine = '';
        if (q?.account) {
            const parts = [];
            if (q.account.email) parts.push(q.account.email);
            if (q.account.type) parts.push(q.account.type);
            if (q.account.plan) parts.push(q.account.plan);
            if (q.account.tier) parts.push(q.account.tier);
            if (parts.length) accountLine = `<div style="font-size:10px;color:var(--text-dim);margin:2px 0 4px 16px">${escapeHtml(parts.join(' · '))}</div>`;
        }

        let windowsHtml = '';
        if (q?.windows?.length) {
            windowsHtml = q.windows.map(w => {
                const pct = Math.round(w.percent);
                const barColor = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#38bdf8';
                return `
                    <div style="display:flex;align-items:center;gap:6px;margin-left:16px;font-size:10px;color:var(--text-dim)">
                        <span style="width:42px">${w.label}</span>
                        <div style="flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
                            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:2px"></div>
                        </div>
                        <span style="width:28px;text-align:right">${pct}%</span>
                    </div>
                `;
            }).join('');
        }

        html += `
            <div class="settings-group" style="margin-bottom:6px;padding:8px 10px">
                <div class="cli-status-row">
                    <span class="cli-dot ${dotClass}"></span>
                    <span class="cli-name" style="font-weight:600">${name}</span>
                </div>
                ${accountLine}
                ${windowsHtml}
            </div>
        `;
    }

    el.innerHTML = html;
}

// ── Prompt Modal ──
export function openPromptModal() {
    fetch('/api/prompt').then(r => r.json()).then(({ content }) => {
        document.getElementById('modalPromptEditor').value = content;
        document.getElementById('promptModal').classList.add('open');
    });
}

export function closePromptModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('promptModal').classList.remove('open');
}

export async function savePromptFromModal() {
    const content = document.getElementById('modalPromptEditor').value;
    await fetch('/api/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    document.getElementById('promptModal').classList.remove('open');
}
