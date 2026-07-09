const RESERVED_NOTE_SEGMENTS = new Set(['.git', '.assets', '_templates', '_snippets', '_plugins']);

export function isLocalPreviewRelayOrigin(origin: string): boolean {
    if (origin === window.location.origin) return true;
    try {
        const hostname = new URL(origin).hostname;
        return hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname === '[::1]';
    } catch {
        return false;
    }
}

export function previewParentOrigin(): string | null {
    if (window.parent === window) return null;
    try {
        const parentOrigin = window.parent.location.origin;
        if (parentOrigin && parentOrigin !== 'null' && isLocalPreviewRelayOrigin(parentOrigin)) {
            return parentOrigin;
        }
    } catch { /* cross-origin preview iframe */ }
    if (parentRelayOriginCache) return parentRelayOriginCache;
    try {
        if (document.referrer) {
            const origin = new URL(document.referrer).origin;
            if (isLocalPreviewRelayOrigin(origin)) return origin;
        }
    } catch { /* ignore */ }
    return null;
}

// Parent-manager capability flags, announced via 'jaw-preview-capabilities'.
// Defaults to false so non-Electron parents keep the openLocalPath fallback.
let parentDocPanelCapable = false;
let parentDocPanelCapabilityKnown = false;
let capabilityListenerReady = false;
let insertTextListenerReady = false;
let parentRelayOriginCache: string | null = null;
const docPanelCapabilityWaiters = new Set<(capable: boolean) => void>();

export function parentSupportsDocPanel(): boolean {
    return parentDocPanelCapable;
}

function rememberParentRelayOrigin(origin: string): void {
    if (!isLocalPreviewRelayOrigin(origin)) return;
    parentRelayOriginCache = origin;
}

function resolveDocPanelCapabilityWaiters(capable: boolean): void {
    for (const resolve of docPanelCapabilityWaiters) resolve(capable);
    docPanelCapabilityWaiters.clear();
}

export function requestPreviewCapabilities(): boolean {
    const targetOrigin = previewParentOrigin() || '*';
    try {
        window.parent.postMessage({ type: 'jaw-preview-capabilities-request' }, targetOrigin);
        return true;
    } catch {
        return false;
    }
}

export function ensurePreviewCapabilityListener(): void {
    if (capabilityListenerReady) return;
    capabilityListenerReady = true;
    window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window.parent) return;
        if (!isLocalPreviewRelayOrigin(event.origin)) return;
        const data = event.data as { type?: unknown; docPanel?: unknown } | null;
        if (!data || data.type !== 'jaw-preview-capabilities') return;
        rememberParentRelayOrigin(event.origin);
        parentDocPanelCapable = data.docPanel === true;
        parentDocPanelCapabilityKnown = true;
        resolveDocPanelCapabilityWaiters(parentDocPanelCapable);
    });
    requestPreviewCapabilities();
}

export function waitForDocPanelCapability(timeoutMs = 180): Promise<boolean> {
    ensurePreviewCapabilityListener();
    if (parentDocPanelCapable || parentDocPanelCapabilityKnown) {
        return Promise.resolve(parentDocPanelCapable);
    }
    if (!requestPreviewCapabilities()) return Promise.resolve(false);
    return new Promise(resolve => {
        let settled = false;
        const finish = (capable: boolean) => {
            if (settled) return;
            settled = true;
            docPanelCapabilityWaiters.delete(finish);
            window.clearTimeout(timer);
            resolve(capable);
        };
        const timer = window.setTimeout(() => finish(parentDocPanelCapable), timeoutMs);
        docPanelCapabilityWaiters.add(finish);
    });
}

function isTextInputElement(element: Element): element is HTMLInputElement {
    if (!(element instanceof HTMLInputElement)) return false;
    return ['text', 'search', 'url', 'tel', 'email', 'password'].includes(element.type);
}

function editableTargetFromElement(element: Element | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
    if (!element) return null;
    if (element instanceof HTMLTextAreaElement) return element;
    if (isTextInputElement(element)) return element;
    const editable = element.closest('[contenteditable="true"]');
    return editable instanceof HTMLElement ? editable : null;
}

function editableTargetAcceptsInput(target: HTMLInputElement | HTMLTextAreaElement | HTMLElement): boolean {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return !target.disabled && !target.readOnly;
    }
    return target.isContentEditable;
}

function isVisibleEditableTarget(target: HTMLInputElement | HTMLTextAreaElement | HTMLElement): boolean {
    if (!editableTargetAcceptsInput(target)) return false;
    if (target === document.activeElement) return true;
    const style = window.getComputedStyle(target);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function findPreviewInsertTarget(): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null {
    const activeTarget = editableTargetFromElement(document.activeElement);
    if (activeTarget && isVisibleEditableTarget(activeTarget)) return activeTarget;

    const selectors = [
        '#chatInput',
        'textarea.chat-input',
        'textarea[data-chat-input="true"]',
        'textarea[aria-label*="chat" i]',
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="메시지" i]',
        'textarea[placeholder*="입력" i]',
        'textarea',
        'input[type="text"]',
        'input[type="search"]',
        'input:not([type])',
        '[contenteditable="true"]',
    ];
    const seen = new Set<Element>();
    for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
            if (seen.has(element)) continue;
            seen.add(element);
            const target = editableTargetFromElement(element);
            if (target && isVisibleEditableTarget(target)) return target;
        }
    }
    return null;
}

function insertIntoEditable(target: Element, text: string): boolean {
    if (target instanceof HTMLTextAreaElement || isTextInputElement(target)) {
        if (!editableTargetAcceptsInput(target)) return false;
        const hasFocus = document.activeElement === target;
        const start = hasFocus ? (target.selectionStart ?? target.value.length) : target.value.length;
        const end = hasFocus ? (target.selectionEnd ?? start) : start;
        target.setRangeText(text, start, end, 'end');
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        target.focus();
        return true;
    }
    const editable = target.closest('[contenteditable="true"]');
    if (!(editable instanceof HTMLElement)) return false;
    if (!editableTargetAcceptsInput(editable)) return false;
    const selection = window.getSelection();
    let range: Range | null = null;
    if (selection && selection.rangeCount > 0) {
        const selectedRange = selection.getRangeAt(0);
        if (editable.contains(selectedRange.commonAncestorContainer)) range = selectedRange;
    }
    if (!range) {
        range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    editable.focus();
    return true;
}

export function ensurePreviewInsertTextListener(): void {
    if (insertTextListenerReady) return;
    insertTextListenerReady = true;
    window.addEventListener('message', (event: MessageEvent) => {
        if (!isLocalPreviewRelayOrigin(event.origin)) return;
        const data = event.data as { type?: unknown; requestId?: unknown; text?: unknown } | null;
        if (!data || data.type !== 'jaw-preview-insert-text') return;
        rememberParentRelayOrigin(event.origin);
        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        const text = typeof data.text === 'string' ? data.text : '';
        const reply = (ok: boolean, error?: string) => {
            if (!requestId) return;
            window.parent.postMessage({ type: 'jaw-preview-insert-text-result', requestId, ok, ...(error ? { error } : {}) }, event.origin);
        };
        if (!requestId || !text) {
            reply(false, 'invalid insert request');
            return;
        }
        const target = findPreviewInsertTarget();
        if (!target || !insertIntoEditable(target, text)) {
            reply(false, 'no editable target');
            return;
        }
        reply(true);
    });
}

export function postPreviewOpenNotes(path: string): boolean {
    const targetOrigin = previewParentOrigin();
    if (!targetOrigin || !path.trim()) return false;
    window.parent.postMessage({ type: 'jaw-preview-open-notes', path }, targetOrigin);
    return true;
}

export function postPreviewOpenDoc(absolutePath: string): boolean {
    const targetOrigin = previewParentOrigin();
    if (!targetOrigin || !absolutePath.trim()) return false;
    window.parent.postMessage({ type: 'jaw-preview-open-doc', path: absolutePath }, targetOrigin);
    return true;
}

export function postPreviewInvalidate(topics: string[], reason: string): boolean {
    const targetOrigin = previewParentOrigin();
    if (!targetOrigin || topics.length === 0) return false;
    window.parent.postMessage({ type: 'dashboard.invalidate', topics, reason }, targetOrigin);
    return true;
}
