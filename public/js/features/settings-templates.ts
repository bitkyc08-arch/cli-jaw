// ── Prompt & Template Modals ──
import { api, apiJson } from '../api.js';
import { ICONS } from '../icons.js';
import { escapeHtml } from '../render.js';
import { t as i18n, getLang, setLang } from '../locale.js';

// ── Prompt Modal ──

export function openPromptModal(): void {
    api<{ content?: string }>('/api/prompt').then(data => {
        if (!data) return;
        const editor = document.getElementById('modalPromptEditor') as HTMLTextAreaElement | null;
        if (editor) editor.value = data.content || '';
        document.getElementById('promptModal')?.classList.add('open');
    });
}

export function closePromptModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('promptModal')?.classList.remove('open');
}

export async function savePromptFromModal(): Promise<void> {
    const editor = document.getElementById('modalPromptEditor') as HTMLTextAreaElement | null;
    const content = editor?.value || '';
    await apiJson('/api/prompt', 'PUT', { content });
    document.getElementById('promptModal')?.classList.remove('open');
}

// ── Template Modal (Node Map + Editor) ──

interface TemplateInfo { id: string; filename: string; content: string; }
interface TreeNode { id: string; label: string; emoji: string; children: string[]; }
let _templates: TemplateInfo[] = [];
let _devMode = false;

export async function openTemplateModal(): Promise<void> {
    const data = await api<{ templates: TemplateInfo[]; tree: TreeNode[] }>('/api/prompt-templates');
    if (!data) return;
    _templates = data.templates;
    _devMode = false;
    renderTree(data.tree);
    showTemplateView('tree');
    document.getElementById('templateModal')?.classList.add('open');
}

function renderTree(tree: TreeNode[]): void {
    const container = document.getElementById('templateTree');
    if (!container) return;
    container.innerHTML = '';
    for (const group of tree) {
        const main = document.createElement('div');
        main.style.cssText = 'background:var(--bg);border:1px solid var(--accent);border-radius:6px;padding:8px 10px;margin:8px 0 4px;font-size:12px;color:var(--accent);font-weight:600';
        main.textContent = `${group.emoji} ${group.label}`;
        container.appendChild(main);
        for (const childId of group.children) {
            const tmpl = _templates.find(t => t.id === childId);
            if (!tmpl) continue;
            const node = document.createElement('div');
            node.style.cssText = 'background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 10px;margin:2px 0 2px 24px;font-size:12px;cursor:pointer;transition:border-color .15s';
            node.innerHTML = `${ICONS.file} ${escapeHtml(tmpl.filename)}`;
            node.addEventListener('mouseenter', () => { node.style.borderColor = 'var(--accent2)'; });
            node.addEventListener('mouseleave', () => { node.style.borderColor = 'var(--border)'; });
            node.addEventListener('click', () => { openTemplateEditor(tmpl); });
            container.appendChild(node);
        }
    }
}

function openTemplateEditor(tmpl: TemplateInfo): void {
    const editor = document.getElementById('templateEditor') as HTMLTextAreaElement;
    editor.value = tmpl.content;
    editor.dataset.templateId = tmpl.id;
    editor.readOnly = true;
    _devMode = false;
    const label = document.getElementById('templateEditorLabel');
    if (label) label.innerHTML = `${ICONS.file} ${escapeHtml(tmpl.filename)}`;
    const vars = tmpl.content.match(/\{\{[A-Z_]+\}\}/g);
    const varsEl = document.getElementById('templateVars');
    if (varsEl) varsEl.textContent = vars ? `vars: ${[...new Set(vars)].join(', ')}` : 'no variables';
    const saveBtn = document.getElementById('templateSaveBtn');
    if (saveBtn) saveBtn.style.display = 'none';
    const toggle = document.getElementById('templateDevToggle');
    if (toggle) { toggle.style.color = 'var(--text-dim)'; toggle.style.borderColor = 'var(--border)'; toggle.innerHTML = `${ICONS.tool} ${i18n('devMode')}`; }
    const title = document.getElementById('templateModalTitle');
    if (title) title.innerHTML = `${ICONS.file} ${escapeHtml(tmpl.filename)}`;
    showTemplateView('editor');
}

export function toggleDevMode(): void {
    if (!_devMode) {
        if (!confirm(i18n('promptEditWarning'))) return;
    }
    _devMode = !_devMode;
    const editor = document.getElementById('templateEditor') as HTMLTextAreaElement;
    editor.readOnly = !_devMode;
    const saveBtn = document.getElementById('templateSaveBtn');
    if (saveBtn) saveBtn.style.display = _devMode ? '' : 'none';
    const toggle = document.getElementById('templateDevToggle');
    if (toggle) {
        toggle.style.color = _devMode ? 'var(--stop-btn)' : 'var(--text-dim)';
        toggle.style.borderColor = _devMode ? 'var(--stop-btn)' : 'var(--border)';
        toggle.innerHTML = _devMode ? `${ICONS.lockOpen} ${i18n('devModeOn')}` : `${ICONS.tool} ${i18n('devMode')}`;
    }
}

export async function saveTemplateFromModal(): Promise<void> {
    const editor = document.getElementById('templateEditor') as HTMLTextAreaElement;
    const id = editor.dataset.templateId;
    if (!id) return;
    await apiJson(`/api/prompt-templates/${id}`, 'PUT', { content: editor.value });
    const label = document.getElementById('templateEditorLabel');
    if (label) { label.innerHTML = `${ICONS.check} ${i18n('savedAndReloaded')}`; setTimeout(() => { label.innerHTML = `${ICONS.file} ${escapeHtml(id)}.md`; }, 2000); }
    const t = _templates.find(x => x.id === id);
    if (t) t.content = editor.value;
}

function showTemplateView(view: 'tree' | 'editor'): void {
    const treeView = document.getElementById('templateTreeView');
    const editorView = document.getElementById('templateEditorView');
    if (treeView) treeView.style.display = view === 'tree' ? '' : 'none';
    if (editorView) editorView.style.display = view === 'editor' ? 'flex' : 'none';
    const title = document.getElementById('templateModalTitle');
    if (title && view === 'tree') title.innerHTML = `${ICONS.plan} ${i18n('promptStructure')}`;
}

export function templateGoBack(): void { showTemplateView('tree'); }

export function closeTemplateModal(e?: Event): void {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('templateModal')?.classList.remove('open');
}
