// ── Slash Command Dropdown ──

let cmdList = [];       // { name, desc, args, category }[]
let filtered = [];      // currently filtered list
let selectedIdx = -1;   // -1 = none
let isOpen = false;
let closeTimer = null;

const dropdown = () => document.getElementById('cmdDropdown');
const input = () => document.getElementById('chatInput');

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function filterCommands(partial) {
    const prefix = String(partial || '').toLowerCase();
    return cmdList.filter(c => (`/${c.name}`).startsWith(prefix));
}

function showDropdown() {
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

function render() {
    const el = dropdown();
    const inp = input();
    if (!el || !inp) return;

    if (!filtered.length) {
        if (!inp.value.startsWith('/')) { close(); return; }

        el.innerHTML = `
            <div class="cmd-item cmd-empty" role="option" aria-disabled="true">
                일치하는 커맨드가 없습니다
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

    const selected = el.querySelector('.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function applySelection(execute) {
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

export async function loadCommands() {
    try {
        const res = await fetch('/api/commands?interface=web');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        cmdList = await res.json();
    } catch {
        cmdList = [];
    }
}

export function close() {
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

export function update(text) {
    const raw = String(text || '');
    if (!raw.startsWith('/') || raw.includes(' ') || raw.includes('\n')) {
        close();
        return;
    }

    filtered = filterCommands(raw);
    selectedIdx = filtered.length ? 0 : -1;
    render();
}

export function handleKeydown(e) {
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

export function handleClick(e) {
    const item = e.target.closest('.cmd-item');
    if (!item) return;
    const idx = parseInt(item.dataset.index || '-1', 10);
    if (Number.isNaN(idx) || idx < 0) return;
    selectedIdx = Math.min(idx, filtered.length - 1);
    applySelection(true);
}

export function handleOutsideClick(e) {
    if (!isOpen) return;
    const el = dropdown();
    const inp = input();
    if (!el || !inp) return;
    if (!el.contains(e.target) && e.target !== inp) {
        close();
    }
}

export function isDropdownOpen() {
    return isOpen;
}
