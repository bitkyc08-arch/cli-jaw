// ── Chat Feature ──
import { state } from '../state.js';
import { addMessage, addSystemMsg } from '../ui.js';
import { getPreferredLocale } from '../locale.js';
import { t } from './i18n.js';
import * as slashCmd from './slash-commands.js';
import { api, apiJson, apiFire, getAuthToken } from '../api.js';
import { escapeHtml, cancelPostRender } from '../render.js';
import { getVirtualScroll } from '../virtual-scroll.js';
import { clearCache, upsertMessage } from './idb-cache.js';
import { ICONS } from '../icons.js';
import { clearUnreadResponses } from './attention-badge.js';
import { syncOrchestrateSnapshot } from '../ws.js';
import { waitForSettingsSaveIdle } from './settings-core.js';

let activeObjectURLs: string[] = [];

interface CommandResult { code?: string; text?: string; type?: string; }
interface MessageResult { queued?: boolean; pending?: number; continued?: boolean; error?: string; queuedId?: string; }

function getCommandTimeoutMs(text: string): number {
    // Native compaction can take materially longer than the default command round-trip.
    return /^\/compact(?:\s|$)/i.test(String(text || '').trim()) ? 5 * 60 * 1000 : 10_000;
}

function isOrchestrateCommand(text: string): boolean {
    return /^\/(?:orchestrate|pabcd)(?:\s|$)/i.test(String(text || '').trim());
}

// In-flight guard: prevents double-send from rapid clicks / Enter-bursts while the
// POST to /api/message is outstanding. Server-side dedup in gateway.ts is the
// second line of defense. See devlog/_plan/260417_message_duplication/.
let __chatSending = false;

export async function sendMessage(): Promise<void> {
    const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    const btn = document.getElementById('btnSend');
    if (!input || !btn) return;

    // Stop-mode click policy (devlog 260501_chat_pause_and_unread_badge):
    //  - busy + click  → no-op. Do not kill the running agent (Bug 1) and do
    //    not fall through into the send path which would queue the typed text
    //    and drain it as a steer (Bug 2).
    //  - idle + empty  → fire /api/stop as the runaway escape hatch (legacy).
    //  - any stop-mode click never falls through to the send path; the
    //    textarea contents and attachments are preserved.
    // Enter-key send is unaffected because document.activeElement is the
    // textarea, not the button, so stopByExplicitButton is false.
    const stopByExplicitButton = document.activeElement === btn;
    if (btn.classList.contains('stop-mode') && stopByExplicitButton) {
        if (state.agentBusy) return;
        if (!input.value.trim() && !state.attachedFiles.length) {
            apiFire('/api/stop', 'POST');
        }
        return;
    }

    // Double-submit guard: if a previous send is still in flight, drop this call.
    if (__chatSending) return;

    const text = input.value.trim();
    if (!text && !state.attachedFiles.length) return;
    clearUnreadResponses();

    // Mark in-flight AND disable send button for visual feedback.
    __chatSending = true;
    const sendBtn = btn as HTMLButtonElement;
    const prevDisabled = sendBtn.disabled;
    sendBtn.disabled = true;
    try {
        await waitForSettingsSaveIdle();

        // File paths like /Users/junny/... or /tmp/foo — not commands
        const afterSlash = text.slice(1).trim();
        const firstToken = afterSlash.split(/\s+/)[0] || '';
        const isFilePath = firstToken.includes('/') || firstToken.includes('\\');

        if (text.startsWith('/') && !state.attachedFiles.length && !isFilePath) {
            const shouldSyncOrchestrate = isOrchestrateCommand(text);
            input.value = '';
            resetInputHeight();
            slashCmd.close();
            try {
                let signal: AbortSignal; let timer: ReturnType<typeof setTimeout> | undefined;
                const timeoutMs = getCommandTimeoutMs(text);
                if (typeof AbortSignal?.timeout === 'function') {
                    signal = AbortSignal.timeout(timeoutMs);
                } else {
                    const ac = new AbortController();
                    signal = ac.signal;
                    timer = setTimeout(() => ac.abort(), timeoutMs);
                }
                const locale = getPreferredLocale();
                const token = await getAuthToken();
                const res = await fetch('/api/command', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept-Language': locale,
                        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify({ text, locale }),
                    signal,
                });
                if (timer) clearTimeout(timer);
                const result: CommandResult = await res.json().catch(() => ({}));
                // not_command → fall through to normal chat
                if (result?.code === 'not_command') {
                    addMessage('user', text);
                    upsertMessage({ role: 'user', content: text, timestamp: Date.now() });
                    await apiJson('/api/message', 'POST', { prompt: text });
                    return;
                }
                if (!res.ok && !result?.text) throw new Error(`HTTP ${res.status}`);
                if (result?.code === 'clear_screen') {
                    cancelPostRender();
                    getVirtualScroll().clear();
                    const chatEl = document.getElementById('chatMessages');
                    if (chatEl) chatEl.innerHTML = '';
                }
                if (result?.text) addSystemMsg(escapeHtml(result.text), '', result.type);
            } catch (err) {
                addSystemMsg(t('chat.cmd.fail', { msg: (err as Error).message }), '', 'error');
            } finally {
                if (shouldSyncOrchestrate) {
                    syncOrchestrateSnapshot('command').catch(() => {});
                }
            }
            return;
        }

        if (state.attachedFiles.length) {
            const names = state.attachedFiles.map((f: File) => f.name).join(', ');
            const displayMsg = `📎 [${names}] ${text}`;
            addMessage('user', displayMsg);
            upsertMessage({ role: 'user', content: displayMsg, timestamp: Date.now() });
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
            // Option A (no-optimistic): clear the input immediately for snappy
            // feedback, but wait for the backend response before rendering any
            // chat bubble. Eliminates every duplicate-bubble class of bug
            // (WS-vs-HTTP race, VS stored-HTML capture, mounted reindex, etc.)
            // because we only addMessage when we know for sure what happened.
            input.value = '';
            resetInputHeight();
            const res = await fetch('/api/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: text }),
            });
            const data: MessageResult = await res.json().catch(() => ({}));
            // Server-side 5s dedup returns 409 with reason='duplicate'.
            if (res.status === 409 && (data as any)?.error === 'duplicate') {
                return;
            }
            if (!res.ok) {
                addSystemMsg(`${ICONS.error} ${escapeHtml(data.error || t('chat.requestFail', { status: res.status }))}`, '', 'error');
                return;
            }
            if (data.queued) {
                // Queued — pending-queue panel owns the visual; nothing in chat yet.
                // The fromQueue broadcast (processQueue / steer route) renders the
                // bubble when the message actually starts running.
                const { updateQueueBadge } = await import('../ui.js');
                updateQueueBadge(data.pending || 1);
            } else if (data.continued) {
                addMessage('user', text);
                upsertMessage({ role: 'user', content: text, timestamp: Date.now() });
                addSystemMsg(t('chat.continue'));
            } else {
                // started: backend already inserted the row; render now.
                addMessage('user', text);
                upsertMessage({ role: 'user', content: text, timestamp: Date.now() });
            }
        }
    } finally {
        __chatSending = false;
        sendBtn.disabled = prevDisabled;
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
    activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
    activeObjectURLs = [];
    state.attachedFiles = [];
    renderFilePreview();
    const fi = document.getElementById('fileInput') as HTMLInputElement | null;
    if (fi) fi.value = '';
}

function renderFilePreview(): void {
    const preview = document.getElementById('filePreview');
    const listEl = document.getElementById('filePreviewList');
    if (!preview) return;
    // Revoke all previous object URLs before creating new ones
    activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
    activeObjectURLs = [];
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
        let thumb = '';
        if (isImg) {
            const url = URL.createObjectURL(f);
            activeObjectURLs.push(url);
            thumb = `<img src="${url}" class="file-chip-thumb" alt="">`;
        }
        return `<div class="file-chip">
            ${thumb}
            <span class="file-chip-name">${ICONS.paperclip} ${escapeHtml(f.name)} (${size}KB)</span>
            <button class="file-chip-remove" data-file-idx="${i}" title="Remove">${ICONS.close}</button>
        </div>`;
    }).join('');
}

export async function clearChat(): Promise<void> {
    // UI-only clear — do NOT call /api/clear (it deletes DB messages)
    cancelPostRender();
    getVirtualScroll().clear();
    const chatEl = document.getElementById('chatMessages');
    if (chatEl) chatEl.innerHTML = '';
    const { cleanupToolActivity } = await import('../ui.js');
    cleanupToolActivity();
    clearCache().catch(() => {});
    clearUnreadResponses();
}

// ── Auto-resize textarea (RAF-batched to avoid blocking input) ──
let resizeRaf = 0;
function autoResize(el: HTMLTextAreaElement): void {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        el.style.height = 'auto';
        el.style.height = el.scrollHeight + 'px';
    });
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

/** Upload recorded voice blob, combine with pending text/files, send unified message */
export async function sendVoiceToServer(blob: Blob, ext: string, mime: string): Promise<void> {
    const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    const pendingText = input?.value.trim() || '';
    const pendingFiles = [...state.attachedFiles];

    // Build user-facing display message
    const displayParts: string[] = ['🎤 [음성 메시지]'];
    if (pendingFiles.length) displayParts.push(`📎 [${pendingFiles.map(f => f.name).join(', ')}]`);
    if (pendingText) displayParts.push(pendingText);
    addMessage('user', displayParts.join(' '));
    upsertMessage({ role: 'user', content: displayParts.join(' '), timestamp: Date.now() });

    // Clear input immediately
    if (input && pendingText) { input.value = ''; resetInputHeight(); }
    if (pendingFiles.length) clearAttachedFiles();

    try {
        // Step 1: STT only (no submitMessage on server)
        const sttRes = await fetch('/api/voice', {
            method: 'POST',
            headers: {
                'Content-Type': mime,
                'X-Voice-Ext': ext,
                'X-STT-Only': 'true',
            },
            body: blob,
        });
        if (!sttRes.ok) {
            const data = await sttRes.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${sttRes.status}`);
        }
        const sttResult = await sttRes.json().catch(() => null);
        if (!sttResult?.text) throw new Error('Empty STT result');

        addSystemMsg(`${ICONS.mic} STT (${escapeHtml(sttResult.engine || '')}, ${sttResult.elapsed?.toFixed(1)}s): "${escapeHtml(sttResult.text.slice(0, 100))}"`, '', 'info');

        // Step 2: Upload pending files (if any)
        let filePaths: string[] = [];
        if (pendingFiles.length) {
            filePaths = await Promise.all(pendingFiles.map(f => uploadFile(f)));
        }

        // Step 3: Build combined prompt and send via /api/message
        const promptParts: string[] = [];
        for (const p of filePaths) {
            promptParts.push(t('chat.file.sent', { path: p }));
        }
        promptParts.push(`🎤 ${sttResult.text}`);
        if (pendingText) promptParts.push(pendingText);

        await apiJson('/api/message', 'POST', { prompt: promptParts.join('\n') });
    } catch (err) {
        addSystemMsg(t('voice.sttFail', { msg: (err as Error).message }), '', 'error');
    }
}
