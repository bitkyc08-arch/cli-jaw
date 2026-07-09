import { api, apiJson } from '../api.js';
import { escapeHtml } from '../render.js';
import { t } from './i18n.js';
import { ICONS } from '../icons.js';

interface McpServer { command?: string; args?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string>; }
interface McpData { servers: Record<string, McpServer>; }
interface McpSyncResult { results: Record<string, boolean>; }
interface McpInstallEntry { status: string; bin?: string; }
interface McpInstallResult { results: Record<string, McpInstallEntry>; }

function getServerTag(s: McpServer): string | null {
    if (s.url) return 'remote';
    if (!s.command) return null;
    const cmd = s.command;
    if (cmd === 'npx' || cmd.endsWith('/npx')) return 'npx';
    if (cmd === 'uvx' || cmd === 'uv' || cmd.endsWith('/uvx')) return 'uvx';
    if (cmd === 'docker' || cmd.endsWith('/docker')) return 'docker';
    return null;
}

function countBundleCandidates(servers: Record<string, McpServer>): number {
    return Object.values(servers).filter(s =>
        s.command === 'npx' || s.command === 'uv' || s.command === 'uvx'
    ).length;
}

let cachedConfig: McpData | null = null;

export async function loadMcpServers(): Promise<void> {
    try {
        const d = await api<McpData>('/api/mcp');
        if (!d) return;
        cachedConfig = d;
        const el = document.getElementById('mcpServerList');
        if (!el) return;
        const entries = Object.entries(d.servers || {});
        if (!entries.length) { el.textContent = t('mcp.noServers'); updateBundleLabel(0); return; }
        el.innerHTML = entries.map(([n, s]) => {
            const tag = getServerTag(s);
            const detail = s.url || [s.command, ...(s.args || []).slice(0, 2)].filter(Boolean).map(a => escapeHtml(a!)).join(' ');
            const tagHtml = tag ? ` <span style="opacity:.5;font-size:0.85em">[${escapeHtml(tag)}]</span>` : '';
            return `<div style="padding:2px 0">• <b>${escapeHtml(n)}</b> <span style="opacity:.6">${detail}</span>${tagHtml}</div>`;
        }).join('');
        updateBundleLabel(countBundleCandidates(d.servers));
    } catch { } // best-effort: MCP list render is non-critical UI
}

function updateBundleLabel(n: number): void {
    const lbl = document.getElementById('installBundleLabel');
    if (lbl) lbl.textContent = `Install bundle (${n})`;
    const btn = lbl?.closest('button');
    if (btn) (btn as HTMLButtonElement).disabled = n === 0;
}

export async function syncMcpServers(): Promise<void> {
    const resultEl = document.getElementById('mcpSyncResult');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.textContent = t('mcp.syncing');
    try {
        const d = await apiJson('/api/mcp/sync', 'POST', {}) as McpSyncResult | null;
        if (!d) { resultEl.innerHTML = `${ICONS.error} sync failed`; return; }
        const r = d.results || {};
        resultEl.innerHTML = Object.entries(r).map(([k, v]) =>
            `${v ? ICONS.check : ICONS.skip} ${escapeHtml(k)}`
        ).join(' &nbsp; ');
    } catch (e) { resultEl.innerHTML = `${ICONS.error} ${escapeHtml((e as Error).message)}`; }
}

export async function installMcpGlobal(): Promise<void> {
    const resultEl = document.getElementById('mcpSyncResult');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.textContent = t('mcp.installing');
    try {
        const d = await apiJson('/api/mcp/install', 'POST', {}) as McpInstallResult | null;
        if (!d) { resultEl.innerHTML = `${ICONS.error} install failed`; return; }
        resultEl.innerHTML = Object.entries(d.results || {}).map(([k, v]) => {
            const ic = v.status === 'installed' ? ICONS.check : v.status === 'skip' ? ICONS.skip : ICONS.error;
            return `${ic} <b>${escapeHtml(k)}</b>: ${escapeHtml(v.status)}${v.bin ? ` ${ICONS.arrowRight} ` + escapeHtml(v.bin) : ''}`;
        }).join('<br>');
        loadMcpServers();
    } catch (e) { resultEl.innerHTML = `${ICONS.error} ${escapeHtml((e as Error).message)}`; }
}

// ── MCP Modal (dynamic, document.body) ──

let overlay: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let activeListEl: HTMLDivElement | null = null;
let addFormEl: HTMLDivElement | null = null;
let addErrorEl: HTMLDivElement | null = null;
let browseEl: HTMLDivElement | null = null;
let currentSubTab: 'local' | 'remote' = 'local';
let openState = false;
let tabBtns: HTMLButtonElement[] = [];

function ensureModal(): void {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.id = 'mcpModal';
    overlay.className = 'modal-overlay mcp-modal-overlay';
    overlay.setAttribute('role', 'presentation');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMcpModal(); });

    const box = document.createElement('div');
    box.className = 'modal-box mcp-modal-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'MCP Server Management');
    box.addEventListener('click', (e) => e.stopPropagation());

    const header = document.createElement('div');
    header.className = 'modal-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'MCP Server Management';
    const helpBtn = document.createElement('button');
    helpBtn.type = 'button';
    helpBtn.className = 'help-trigger';
    helpBtn.textContent = '?';
    helpBtn.setAttribute('aria-label', 'MCP help');
    helpBtn.addEventListener('click', () => showMcpHelp());
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', () => closeMcpModal());
    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display:flex;align-items:center;gap:6px';
    headerLeft.append(titleSpan, helpBtn);
    header.append(headerLeft, closeBtn);

    bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'padding:16px;overflow-y:auto;flex:1';

    const tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:4px;margin-bottom:12px';
    const tabActive = createTabBtn('Active Servers', true);
    const tabAdd = createTabBtn('Add New', false);
    const tabBrowse = createTabBtn('Browse', false);
    tabBtns = [tabActive, tabAdd, tabBrowse];
    tabActive.addEventListener('click', () => switchTab('active'));
    tabAdd.addEventListener('click', () => switchTab('add'));
    tabBrowse.addEventListener('click', () => switchTab('browse'));
    tabs.append(tabActive, tabAdd, tabBrowse);

    activeListEl = document.createElement('div');

    browseEl = document.createElement('div');
    browseEl.style.display = 'none';
    browseEl.innerHTML = '<p style="opacity:.5">Loading registry...</p>';

    addFormEl = document.createElement('div');
    addFormEl.style.display = 'none';
    addFormEl.innerHTML = buildAddFormHTML();
    addFormEl.querySelectorAll<HTMLButtonElement>('[data-mcp-subtab]').forEach(btn => {
        btn.addEventListener('click', () => {
            currentSubTab = btn.dataset['mcpSubtab'] as 'local' | 'remote';
            switchSubTab();
        });
    });
    addErrorEl = addFormEl.querySelector('#mcpAddError');
    const addBtn = addFormEl.querySelector('[data-action="mcpAddAndSync"]');
    if (addBtn) addBtn.addEventListener('click', () => void handleAddAndSync());
    const cancelBtn = addFormEl.querySelector('[data-action="closeMcpModal"]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => closeMcpModal());

    bodyEl.append(tabs, activeListEl, browseEl, addFormEl);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn-save';
    doneBtn.textContent = 'Close';
    doneBtn.addEventListener('click', () => closeMcpModal());
    footer.append(doneBtn);

    box.append(header, bodyEl, footer);
    overlay.append(box);
    document.body.append(overlay);
}

function createTabBtn(label: string, active: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn-clear btn-tab${active ? ' is-active' : ''}`;
    btn.textContent = label;
    return btn;
}

function buildAddFormHTML(): string {
    return `
        <div style="display:flex;gap:4px;margin-bottom:8px">
            <button type="button" class="btn-clear btn-tab is-active" data-mcp-subtab="local">Local</button>
            <button type="button" class="btn-clear btn-tab" data-mcp-subtab="remote">Remote</button>
        </div>
        <div id="mcpAddLocal">
            <div class="settings-row"><label>Name</label><input type="text" id="mcpAddName" placeholder="my-server"></div>
            <div class="settings-row"><label>Command</label><input type="text" id="mcpAddCommand" placeholder="npx"></div>
            <div class="settings-row"><label>Args (comma separated)</label><input type="text" id="mcpAddArgs" placeholder="-y, @upstash/context7-mcp"></div>
            <div class="settings-row"><label>Env (KEY=value per line)</label><textarea id="mcpAddEnv" rows="2" placeholder="API_KEY=xxx"></textarea></div>
        </div>
        <div id="mcpAddRemote" style="display:none">
            <div class="settings-row"><label>Name</label><input type="text" id="mcpAddRemoteName" placeholder="my-api"></div>
            <div class="settings-row"><label>URL</label><input type="text" id="mcpAddUrl" placeholder="https://mcp.example.com/sse"></div>
            <div class="settings-row"><label>Headers (KEY=value per line)</label><textarea id="mcpAddHeaders" rows="2"></textarea></div>
        </div>
        <div id="mcpAddError" class="text-error text-xs py-1" style="display:none"></div>
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
            <button type="button" class="btn-clear" data-action="closeMcpModal">Cancel</button>
            <button type="button" class="btn-clear btn-save" data-action="mcpAddAndSync">Add & Sync</button>
        </div>`;
}

function switchTab(tab: 'active' | 'add' | 'browse'): void {
    if (activeListEl) activeListEl.style.display = tab === 'active' ? '' : 'none';
    if (addFormEl) addFormEl.style.display = tab === 'add' ? '' : 'none';
    if (browseEl) browseEl.style.display = tab === 'browse' ? '' : 'none';
    tabBtns.forEach((btn, i) => {
        const t = ['active', 'add', 'browse'][i];
        btn.classList.toggle('is-active', t === tab);
    });
    if (tab === 'active') renderActiveList();
    if (tab === 'add') clearAddInputs();
    if (tab === 'browse') void loadRegistry();
}

function switchSubTab(): void {
    const local = addFormEl?.querySelector('#mcpAddLocal') as HTMLElement | null;
    const remote = addFormEl?.querySelector('#mcpAddRemote') as HTMLElement | null;
    if (local) local.style.display = currentSubTab === 'local' ? '' : 'none';
    if (remote) remote.style.display = currentSubTab === 'remote' ? '' : 'none';
    addFormEl?.querySelectorAll<HTMLButtonElement>('[data-mcp-subtab]').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset['mcpSubtab'] === currentSubTab);
    });
}

function renderActiveList(): void {
    if (!activeListEl || !cachedConfig) return;
    const entries = Object.entries(cachedConfig.servers || {});
    if (!entries.length) { activeListEl.innerHTML = '<p style="opacity:.5">No active MCP servers.</p>'; return; }
    activeListEl.innerHTML = entries.map(([name, srv]) => {
        const tag = getServerTag(srv);
        const tagHtml = tag ? `<span class="mcp-active-tag">[${escapeHtml(tag)}]</span>` : '';
        const cmdLine = srv.command ? escapeHtml(srv.command) + (srv.args?.length ? ' ' + srv.args.map(a => escapeHtml(a)).join(' ') : '') : '';
        const urlLine = srv.url ? escapeHtml(srv.url) : '';
        const envKeys = srv.env ? Object.keys(srv.env) : [];
        const headerKeys = srv.headers ? Object.keys(srv.headers) : [];

        let detailHtml = '';
        if (urlLine) detailHtml += `<div class="mcp-active-detail">URL: ${urlLine}</div>`;
        if (cmdLine) detailHtml += `<div class="mcp-active-detail">Command: ${cmdLine}</div>`;
        if (envKeys.length) detailHtml += `<div class="mcp-active-detail">Env: ${envKeys.map(k => escapeHtml(k)).join(', ')}</div>`;
        if (headerKeys.length) detailHtml += `<div class="mcp-active-detail">Headers: ${headerKeys.map(k => escapeHtml(k)).join(', ')}</div>`;

        return `<div class="mcp-active-row">
            <div style="flex:1">
                <div style="display:flex;align-items:center;gap:6px">
                    <span class="mcp-active-name">${escapeHtml(name)}</span>
                    ${tagHtml}
                </div>
                ${detailHtml}
            </div>
            <button type="button" class="btn-clear mcp-active-remove" data-mcp-remove="${escapeHtml(name)}">Remove</button>
        </div>`;
    }).join('');
    activeListEl.querySelectorAll<HTMLButtonElement>('[data-mcp-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.dataset['mcpRemove'];
            if (name) void removeMcpServer(name);
        });
    });
}

async function removeMcpServer(name: string): Promise<void> {
    if (!cachedConfig) return;
    const nextServers = { ...cachedConfig.servers };
    delete nextServers[name];
    try {
        await apiJson('/api/mcp', 'PUT', { ...cachedConfig, servers: nextServers });
        await apiJson('/api/mcp/sync', 'POST', {});
        await loadMcpServers();
        renderActiveList();
    } catch (e) {
        showAddError((e as Error).message);
    }
}

function clearAddInputs(): void {
    const ids = ['mcpAddName', 'mcpAddCommand', 'mcpAddArgs', 'mcpAddEnv', 'mcpAddRemoteName', 'mcpAddUrl', 'mcpAddHeaders'];
    for (const id of ids) {
        const el = (addFormEl ?? document).querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | null;
        if (el) el.value = '';
    }
    hideAddError();
}

function showAddError(msg: string): void {
    if (!addErrorEl) return;
    addErrorEl.style.display = 'block';
    addErrorEl.textContent = msg;
}

function hideAddError(): void {
    if (addErrorEl) addErrorEl.style.display = 'none';
}

function parseKV(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    return out;
}

function getInput(id: string): string {
    const el = (addFormEl ?? document).querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | null;
    return el?.value?.trim() ?? '';
}

async function handleAddAndSync(): Promise<void> {
    if (!cachedConfig) return;
    const isRemote = currentSubTab === 'remote';
    let name: string;
    let server: McpServer;

    if (isRemote) {
        name = getInput('mcpAddRemoteName');
        const url = getInput('mcpAddUrl');
        const headersText = getInput('mcpAddHeaders');
        if (!name) { showAddError('Name is required.'); return; }
        if (!url) { showAddError('URL is required.'); return; }
        server = { url };
        const h = parseKV(headersText);
        if (Object.keys(h).length > 0) server.headers = h;
    } else {
        name = getInput('mcpAddName');
        const command = getInput('mcpAddCommand');
        const argsText = getInput('mcpAddArgs');
        const envText = getInput('mcpAddEnv');
        if (!name) { showAddError('Name is required.'); return; }
        if (!command) { showAddError('Command is required.'); return; }
        server = { command };
        const args = argsText.split(/,|\n/).map(s => s.trim()).filter(Boolean);
        if (args.length > 0) server.args = args;
        const env = parseKV(envText);
        if (Object.keys(env).length > 0) server.env = env;
    }

    if (cachedConfig.servers[name]) {
        showAddError(`Server "${name}" already exists.`);
        return;
    }

    try {
        const merged = { ...cachedConfig, servers: { ...cachedConfig.servers, [name]: server } };
        await apiJson('/api/mcp', 'PUT', merged);
        await apiJson('/api/mcp/sync', 'POST', {});
        await loadMcpServers();
        closeMcpModal();
    } catch (e) {
        showAddError((e as Error).message);
    }
}

// ── MCP Help popup (in-popup) ──

function showMcpHelp(): void {
    const existing = document.getElementById('mcpHelpOverlay');
    if (existing) { existing.remove(); return; }

    const helpOverlay = document.createElement('div');
    helpOverlay.id = 'mcpHelpOverlay';
    helpOverlay.className = 'mcp-help-overlay';
    helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) helpOverlay.remove(); });

    const inner = document.createElement('div');
    inner.className = 'mcp-help-inner';
    inner.innerHTML = `
        <h4>MCP Server</h4>
        <p>MCP (Model Context Protocol) adds capabilities to AI agents — like installing apps on a phone.</p>

        <h4>Local Server</h4>
        <p>Runs on your machine. Provide a command and args.</p>
        <pre>Name: context7
Command: npx
Args: -y, @upstash/context7-mcp</pre>

        <h4>Remote Server</h4>
        <p>Connects to an external URL (SSE or Streamable HTTP).</p>
        <pre>Name: my-api
URL: https://mcp.example.com/sse</pre>

        <h4>Server Types</h4>
        <p><code>[npx]</code> Node.js package (npx -y ...)<br>
        <code>[uvx]</code> Python package (uvx ...)<br>
        <code>[docker]</code> Docker container<br>
        <code>[remote]</code> External URL</p>

        <h4>After Adding</h4>
        <p>The server is automatically synced to all installed CLIs (Claude, Codex, Gemini, Cursor, Copilot, OpenCode).</p>
        <p><code>Install bundle</code> converts npx/uvx servers to global binaries for faster startup.</p>

        <div style="text-align:right;margin-top:12px">
            <button type="button" class="btn-save" id="mcpHelpClose">OK</button>
        </div>
    `;
    helpOverlay.append(inner);
    document.body.append(helpOverlay);
    inner.querySelector('#mcpHelpClose')?.addEventListener('click', () => helpOverlay.remove());
}

interface RegistryEntry {
    id: string; name: string; description: string; category: string;
    type: string; config: Record<string, unknown>; tags: string[]; url: string;
}

interface HarnessBuiltin {
    id: string; name: string; description: string; source: string; harness: string;
    standalone_config?: Record<string, unknown>;
}

async function loadRegistry(): Promise<void> {
    if (!browseEl) return;
    browseEl.innerHTML = '<p style="opacity:.5">Loading registry...</p>';
    if (!cachedConfig) await loadMcpServers();
    try {
        const res = await api<{ ok: boolean; entries: RegistryEntry[]; builtins?: HarnessBuiltin[] }>('/api/mcp/registry');
        if (!res?.entries?.length && !res?.builtins?.length) {
            browseEl.innerHTML = '<p style="opacity:.5">No MCP servers in registry.</p>';
            return;
        }
        const installed = cachedConfig ? Object.keys(cachedConfig.servers) : [];
        let html = '';
        html += res.entries.map(entry => {
            const isInstalled = installed.includes(entry.id);
            const tagHtml = entry.tags?.slice(0, 3).map(t => `<span style="background:var(--border);padding:1px 4px;border-radius:3px;font-size:10px">${escapeHtml(t)}</span>`).join(' ') || '';
            return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
                <div style="display:flex;align-items:center;gap:8px">
                    <b>${escapeHtml(entry.name)}</b>
                    <span style="opacity:.5;font-size:0.85em">[${escapeHtml(entry.type)}]</span>
                    <span style="opacity:.4;font-size:0.85em">${escapeHtml(entry.category)}</span>
                    ${isInstalled
                        ? '<span style="color:var(--success);font-size:11px">Installed</span>'
                        : `<button type="button" class="btn-clear text-xs" style="color:var(--accent)" data-registry-install="${escapeHtml(entry.id)}">+ Install</button>`
                    }
                </div>
                <p style="margin:4px 0 4px 0;font-size:12px;opacity:.75">${escapeHtml(entry.description)}</p>
                <div style="display:flex;gap:4px;align-items:center">
                    ${tagHtml}
                    ${entry.url ? `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer" style="font-size:10px;opacity:.5;margin-left:auto">source</a>` : ''}
                </div>
            </div>`;
        }).join('');

        if (res.builtins?.length) {
            html += `<div style="margin-top:16px;padding-top:12px;border-top:2px solid var(--border)">
                <h4 style="font-size:12px;opacity:.6;margin:0 0 8px">Harness Built-ins (omo / omx)</h4>
                <p style="font-size:11px;opacity:.4;margin:0 0 8px">Not installable via registry — built into harness runtimes. Listed for reference.</p>`;
            html += res.builtins.map(b => {
                const hasStandalone = b.standalone_config && Object.keys(b.standalone_config).length > 0;
                return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
                    <div style="display:flex;align-items:center;gap:6px">
                        <b style="font-size:12px">${escapeHtml(b.name)}</b>
                        <span style="opacity:.4;font-size:0.8em">${escapeHtml(b.harness)}</span>
                        ${hasStandalone ? `<button type="button" class="btn-clear text-xs" style="color:var(--accent)" data-builtin-install="${escapeHtml(b.id)}">+ Install standalone</button>` : ''}
                    </div>
                    <p style="margin:2px 0;font-size:11px;opacity:.65">${escapeHtml(b.description)}</p>
                </div>`;
            }).join('');
            html += '</div>';
        }

        browseEl.innerHTML = html;
        browseEl.querySelectorAll<HTMLButtonElement>('[data-registry-install]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['registryInstall'];
                const entry = res.entries.find(e => e.id === id);
                if (entry) void installFromRegistry(entry, btn);
            });
        });
        browseEl.querySelectorAll<HTMLButtonElement>('[data-builtin-install]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['builtinInstall'];
                const builtin = res.builtins?.find(b => b.id === id);
                if (builtin?.standalone_config) {
                    void installFromRegistry({
                        id: builtin.id,
                        name: builtin.name,
                        description: builtin.description,
                        category: 'harness',
                        type: 'remote',
                        config: builtin.standalone_config,
                        tags: [],
                        url: builtin.source,
                    }, btn);
                }
            });
        });
    } catch (e) {
        browseEl.innerHTML = `<p style="color:var(--color-error)">${escapeHtml((e as Error).message)}</p>`;
    }
}

async function installFromRegistry(entry: RegistryEntry, btn: HTMLButtonElement): Promise<void> {
    if (!cachedConfig) return;
    btn.disabled = true;
    btn.textContent = 'Installing...';
    try {
        const server = entry.config as McpServer;
        const merged = { ...cachedConfig, servers: { ...cachedConfig.servers, [entry.id]: server } };
        await apiJson('/api/mcp', 'PUT', merged);
        await apiJson('/api/mcp/sync', 'POST', {});
        await loadMcpServers();
        btn.textContent = 'Installed';
        btn.style.color = 'var(--success)';
    } catch (e) {
        btn.textContent = 'Error';
        btn.disabled = false;
        console.error('[mcp-registry] install failed:', (e as Error).message);
    }
}

export function openMcpModal(): void {
    ensureModal();
    overlay?.classList.add('open');
    overlay?.setAttribute('aria-hidden', 'false');
    openState = true;
    switchTab('active');
}

export function closeMcpModal(): void {
    if (!openState) return;
    overlay?.classList.remove('open');
    overlay?.setAttribute('aria-hidden', 'true');
    openState = false;
    clearAddInputs();
    document.getElementById('mcpHelpOverlay')?.remove();
}

let mcpModalInitialized = false;

export function initMcpModal(): void {
    // capture-phase document listener stacks if init ever re-runs (260613 06).
    if (mcpModalInitialized) return;
    mcpModalInitialized = true;
    document.addEventListener('keydown', (e) => {
        if (document.getElementById('mcpHelpOverlay')) {
            if (e.key === 'Escape') { e.preventDefault(); document.getElementById('mcpHelpOverlay')?.remove(); return; }
        }
        if (openState && e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            closeMcpModal();
        }
    }, true);
}
