// ── Slash Command Dropdown ──
import { getPreferredLocale } from '../locale.js';
import { t } from './i18n.js';
import { api } from '../api.js';

interface SlashCommand {
    name: string;
    desc: string;
    args?: string;
    category?: string;
}

let cmdList: SlashCommand[] = [];
let filtered: SlashCommand[] = [];
let selectedIdx = -1;
let isOpen = false;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function looksLikeFilePath(text: string): boolean {
    const after = String(text || '').slice(1).trim();
    const tok = after.split(/\s+/)[0] || '';
    return tok.includes('/') || tok.includes('\\');
}

const dropdown = (): HTMLElement | null => document.getElementById('cmdDropdown');
const input = (): HTMLTextAreaElement | null => document.getElementById('chatInput') as HTMLTextAreaElement | null;

function escapeHtml(str: string): string {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function filterCommands(partial: string): SlashCommand[] {
    const prefix = String(partial || '').toLowerCase();
    return cmdList.filter(c => (`/${c.name}`).startsWith(prefix));
}

function showDropdown(): void {
    const el = dropdown();
    const inp = input();
    if (!el || !inp) return;

    if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
    }

    el.style.display = 'block';
    requestAnimationFrame(() => el.classList.add('visible'));
    isOpen = true;
    inp.setAttribute('aria-expanded', 'true');
}

function render(): void {
    const el = dropdown();
    const inp = input();
    if (!el || !inp) return;

    if (!filtered.length) {
        if (!inp.value.startsWith('/') || looksLikeFilePath(inp.value)) { close(); return; }
        el.innerHTML = `
            <div class="cmd-item cmd-empty" role="option" aria-disabled="true">
                ${t('cmd.noMatch')}
            </div>
        `;
        showDropdown();
        inp.setAttribute('aria-activedescendant', '');
        return;
    }

    el.innerHTML = filtered.map((cmd, i) => {
        const selected = i === selectedIdx;
        return `<div class="cmd-item${selected ? ' selected' : ''}"
                     role="option"
                     id="cmd-item-${i}"
                     aria-selected="${selected}"
                     data-index="${i}">
            <span class="cmd-name">/${escapeHtml(cmd.name)}</span>
            <span class="cmd-desc">${escapeHtml(cmd.desc)}</span>
            ${cmd.args ? `<span class="cmd-args">${escapeHtml(cmd.args)}</span>` : ''}
        </div>`;
    }).join('');

    showDropdown();
    inp.setAttribute('aria-activedescendant', selectedIdx >= 0 ? `cmd-item-${selectedIdx}` : '');

    const selectedEl = el.querySelector('.selected');
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
}

function applySelection(execute: boolean): void {
    const cmd = filtered[selectedIdx];
    const inp = input();
    if (!cmd || !inp) { close(); return; }

    close();
    if (cmd.args || !execute) {
        inp.value = `/${cmd.name} `;
        inp.focus();
        inp.selectionStart = inp.selectionEnd = inp.value.length;
        return;
    }

    inp.value = `/${cmd.name}`;
    inp.dispatchEvent(new Event('cmd-execute', { bubbles: true }));
}

export async function loadCommands(): Promise<void> {
    try {
        const locale = getPreferredLocale();
        const url = `/api/commands?interface=web&locale=${encodeURIComponent(locale)}`;
        const data = await api<SlashCommand[]>(url, { headers: { 'Accept-Language': locale } });
        cmdList = data || [];
    } catch (err) {
        console.warn('[slash-commands] loadCommands failed:', (err as Error).message);
        cmdList = [];
    }
}

export function close(): void {
    const el = dropdown();

    if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
    }
    if (el) {
        el.classList.remove('visible');
        closeTimer = setTimeout(() => {
            if (el.classList.contains('visible')) return;
            el.style.display = 'none';
            el.innerHTML = '';
        }, 150);
    }

    isOpen = false;
    selectedIdx = -1;
    filtered = [];

    const inp = input();
    if (inp) {
        inp.setAttribute('aria-expanded', 'false');
        inp.setAttribute('aria-activedescendant', '');
    }
}

export function update(text: string): void {
    const raw = String(text || '');
    if (!raw.startsWith('/') || raw.includes(' ') || raw.includes('\n') || looksLikeFilePath(raw)) {
        close();
        return;
    }
    filtered = filterCommands(raw);
    selectedIdx = filtered.length ? 0 : -1;
    render();
}

export function handleKeydown(e: KeyboardEvent): boolean {
    if (!isOpen) {
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.isComposing) {
            update(input()?.value || '');
            if (!isOpen) return false;
            selectedIdx = e.key === 'ArrowUp' ? filtered.length - 1 : 0;
            render();
            e.preventDefault();
            return true;
        }
        return false;
    }

    if (!filtered.length) {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return true;
        }
        return false;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIdx = Math.min(filtered.length - 1, selectedIdx + 1);
        render();
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIdx = Math.max(0, selectedIdx - 1);
        render();
        return true;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        applySelection(false);
        return true;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        applySelection(true);
        return true;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return true;
    }
    return false;
}

export function handleClick(e: Event): void {
    const target = e.target as HTMLElement;
    const item = target.closest('.cmd-item') as HTMLElement | null;
    if (!item) return;
    const idx = parseInt(item.dataset.index || '-1', 10);
    if (Number.isNaN(idx) || idx < 0) return;
    selectedIdx = Math.min(idx, filtered.length - 1);
    applySelection(true);
}

export function handleOutsideClick(e: Event): void {
    if (!isOpen) return;
    const el = dropdown();
    const inp = input();
    if (!el || !inp) return;
    const target = e.target as Node;
    if (!el.contains(target) && target !== inp) {
        close();
    }
}

export function isDropdownOpen(): boolean {
    return isOpen;
}
