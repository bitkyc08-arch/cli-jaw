// ── Chat Feature ──
import { state } from '../state.js';
import { addMessage, addSystemMsg, scrollToBottom } from '../ui.js';
import { getPreferredLocale } from '../locale.js';
import { t } from './i18n.js';
import * as slashCmd from './slash-commands.js';
import { api, apiJson, apiFire } from '../api.js';

interface CommandResult { code?: string; text?: string; type?: string; }
interface MessageResult { queued?: boolean; pending?: number; continued?: boolean; error?: string; }

export async function sendMessage(): Promise<void> {
    const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    const btn = document.getElementById('btnSend');
    if (!input || !btn) return;

    // Stop mode: clicking ■ stops the agent
    if (btn.classList.contains('stop-mode') && !input.value.trim() && !state.attachedFiles.length) {
        apiFire('/api/stop', 'POST');
        return;
    }

    const text = input.value.trim();
    if (!text && !state.attachedFiles.length) return;

    // File paths like /Users/junny/... or /tmp/foo — not commands
    const afterSlash = text.slice(1).trim();
    const firstToken = afterSlash.split(/\s+/)[0] || '';
    const isFilePath = firstToken.includes('/') || firstToken.includes('\\');

    if (text.startsWith('/') && !state.attachedFiles.length && !isFilePath) {
        input.value = '';
        resetInputHeight();
        slashCmd.close();
        try {
            let signal: AbortSignal; let timer: ReturnType<typeof setTimeout> | undefined;
            if (typeof AbortSignal?.timeout === 'function') {
                signal = AbortSignal.timeout(10000);
            } else {
                const ac = new AbortController();
                signal = ac.signal;
                timer = setTimeout(() => ac.abort(), 10000);
            }
            const locale = getPreferredLocale();
            const res = await fetch('/api/command', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept-Language': locale,
                },
                body: JSON.stringify({ text, locale }),
                signal,
            });
            if (timer) clearTimeout(timer);
            const result: CommandResult = await res.json().catch(() => ({}));
            // not_command → fall through to normal chat
            if (result?.code === 'not_command') {
                addMessage('user', text);
                await apiJson('/api/message', 'POST', { prompt: text });
                return;
            }
            if (!res.ok && !result?.text) throw new Error(`HTTP ${res.status}`);
            if (result?.code === 'clear_screen') {
                const chatEl = document.getElementById('chatMessages');
                if (chatEl) chatEl.innerHTML = '';
            }
            if (result?.text) addSystemMsg(result.text, '', result.type);
        } catch (err) {
            addSystemMsg(t('chat.cmd.fail', { msg: (err as Error).message }), '', 'error');
        }
        return;
    }

    if (state.attachedFiles.length) {
        const names = state.attachedFiles.map((f: File) => f.name).join(', ');
        const displayMsg = `[📎 ${names}] ${text}`;
        addMessage('user', displayMsg);
        input.value = '';
        resetInputHeight();
        try {
            // Upload all files in parallel
            const paths = await Promise.all(state.attachedFiles.map((f: File) => uploadFile(f)));
            let prompt = paths.map(p => t('chat.file.sent', { path: p })).join('\n');
            if (text) prompt += t('chat.file.sentWithMsg', { text });
            clearAttachedFiles();
            await apiJson('/api/message', 'POST', { prompt });
        } catch (err) {
            addSystemMsg(t('chat.file.uploadFail', { msg: (err as Error).message }));
            clearAttachedFiles();
        }
    } else {
        addMessage('user', text);
        input.value = '';
        resetInputHeight();
        const res = await fetch('/api/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text }),
        });
        const data: MessageResult = await res.json().catch(() => ({}));
        if (!res.ok) {
            addSystemMsg(`❌ ${data.error || t('chat.requestFail', { status: res.status })}`, '', 'error');
            return;
        }
        if (data.queued) {
            const { updateQueueBadge } = await import('../ui.js');
            updateQueueBadge(data.pending || 1);
        } else if (data.continued) {
            addSystemMsg(t('chat.continue'));
        }
    }
}

export function handleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
}

async function uploadFile(file: File): Promise<string> {
    const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(file.name) },
        body: file,
    });
    if (!res.ok) throw new Error('upload failed');
    const data = await res.json();
    return data.path;
}

export function attachFiles(files: File[]): void {
    for (const file of files) {
        if (state.attachedFiles.some(f => f.name === file.name)) continue;
        state.attachedFiles.push(file);
    }
    renderFilePreview();
    (document.getElementById('chatInput') as HTMLTextAreaElement | null)?.focus();
}

export function removeAttachedFile(index: number): void {
    state.attachedFiles.splice(index, 1);
    renderFilePreview();
}

export function clearAttachedFiles(): void {
    state.attachedFiles = [];
    renderFilePreview();
    const fi = document.getElementById('fileInput') as HTMLInputElement | null;
    if (fi) fi.value = '';
}

function renderFilePreview(): void {
    const preview = document.getElementById('filePreview');
    const listEl = document.getElementById('filePreviewList');
    if (!preview) return;
    if (!state.attachedFiles.length) {
        preview.classList.remove('visible');
        if (listEl) listEl.innerHTML = '';
        return;
    }
    preview.classList.add('visible');
    if (!listEl) return;
    listEl.innerHTML = state.attachedFiles.map((f: File, i: number) => {
        const size = (f.size / 1024).toFixed(1);
        const isImg = f.type.startsWith('image/');
        const thumb = isImg ? `<img src="${URL.createObjectURL(f)}" class="file-chip-thumb" alt="">` : '';
        return `<div class="file-chip">
            ${thumb}
            <span class="file-chip-name">📎 ${f.name} (${size}KB)</span>
            <button class="file-chip-remove" data-file-idx="${i}" title="Remove">✕</button>
        </div>`;
    }).join('');
}

export async function clearChat(): Promise<void> {
    apiFire('/api/clear', 'POST');
    const chatEl = document.getElementById('chatMessages');
    if (chatEl) chatEl.innerHTML = '';
}

// ── Auto-resize textarea ──
function autoResize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

export function initAutoResize(): void {
    const el = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    if (el) el.addEventListener('input', () => autoResize(el));
}

export function resetInputHeight(): void {
    const el = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    if (el) el.style.height = 'auto';
}

export function initDragDrop(): void {
    const chatArea = document.querySelector('.chat-area');
    const overlay = document.getElementById('dragOverlay');
    if (!chatArea || !overlay) return;
    let dragCounter = 0;

    chatArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        overlay.classList.add('visible');
    });
    chatArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); }
    });
    chatArea.addEventListener('dragover', (e) => e.preventDefault());
    chatArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        overlay.classList.remove('visible');
        const de = e as DragEvent;
        const files = [...(de.dataTransfer?.files || [])];
        if (files.length) attachFiles(files);
    });

    (document.getElementById('fileInput') as HTMLInputElement | null)?.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        const files = [...(target.files || [])];
        if (files.length) attachFiles(files);
        target.value = '';
    });

    // ── Clipboard paste (Cmd+V) ──
    document.addEventListener('paste', (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (const item of items) {
            if (item.kind !== 'file') continue;
            const blob = item.getAsFile();
            if (!blob) continue;
            if (!blob.name || blob.name === 'image.png') {
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const ext = blob.type.split('/')[1] || 'png';
                const named = new File([blob], `pasted-${ts}.${ext}`, { type: blob.type });
                files.push(named);
            } else {
                files.push(blob);
            }
        }
        if (files.length) {
            e.preventDefault();
            attachFiles(files);
        }
    });
}
