import { escapeHtml } from './html.js';
import { t } from '../features/i18n.js';
import { canSendFromCurrentView, showReadOnlySwitchAffordance } from '../features/session-hub.js';

type ComposeKind = 'email' | 'message' | 'document' | 'other';

type ComposeVariant = {
    id: string;
    label: string;
    subject: string;
    body: string;
};

export type ComposeBlockSpec = {
    schemaVersion: 'compose-block-v1';
    kind: ComposeKind;
    title: string;
    subject: string;
    variants: ComposeVariant[];
};

const PENDING_SELECTOR = '.compose-block-pending';
const BLOCK_SELECTOR = '.compose-block';
const MAX_TITLE = 120;
const MAX_SUBJECT = 180;
const MAX_BODY = 20000;
const MAX_FOLLOWUP = 4000;
const MAX_VARIANTS = 3;

const blockSpecs = new WeakMap<HTMLElement, ComposeBlockSpec>();
let delegatedDocument: Document | null = null;

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function asText(value: unknown, max: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > max ? text.slice(0, max) : text;
}

function asTextList(value: unknown, max: number): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    let total = 0;
    for (const item of value) {
        const text = typeof item === 'string' ? item.trim() : '';
        if (!text) continue;
        const remaining = max - total;
        if (remaining <= 0) break;
        const clipped = text.length > remaining ? text.slice(0, remaining) : text;
        out.push(clipped);
        total += clipped.length;
    }
    return out;
}

function normalizeBody(obj: Record<string, unknown>): string {
    const body = asText(obj['body'], MAX_BODY);
    if (body) return body;
    const paragraphs = asTextList(obj['paragraphs'], MAX_BODY);
    if (paragraphs.length > 0) return paragraphs.join('\n\n');
    const lines = asTextList(obj['bodyLines'], MAX_BODY);
    if (lines.length > 0) return lines.join('\n');
    return '';
}

function normalizeKind(value: unknown): ComposeKind {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === 'email' || raw === 'message' || raw === 'document' || raw === 'other') return raw;
    if (raw === 'textMessage') return 'message';
    return 'other';
}

function parseSpec(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function encodeSpec(spec: ComposeBlockSpec): string {
    return encodeURIComponent(JSON.stringify(spec));
}

function readSpecFromBlock(block: HTMLElement): ComposeBlockSpec | null {
    const encoded = block.dataset['composeBlockSpec'] || '';
    let decoded = '';
    try {
        decoded = decodeURIComponent(encoded);
    } catch {
        decoded = '';
    }
    return normalizeComposeBlockSpec(parseSpec(decoded));
}

function normalizeVariant(raw: unknown, index: number, fallbackSubject: string): ComposeVariant | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    const body = normalizeBody(obj);
    if (!body) return null;
    const label = asText(obj['label'], 40) || `Variant ${index + 1}`;
    const id = asText(obj['id'], 60) || `variant_${index + 1}`;
    return {
        id,
        label,
        subject: asText(obj['subject'], MAX_SUBJECT) || fallbackSubject,
        body,
    };
}

export function normalizeComposeBlockSpec(raw: unknown): ComposeBlockSpec | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (obj['schemaVersion'] !== 'compose-block-v1') return null;
    const kind = normalizeKind(obj['kind']);
    const subject = asText(obj['subject'], MAX_SUBJECT);
    const variantsRaw = Array.isArray(obj['variants']) ? obj['variants'] : [];
    const variants = variantsRaw
        .map((variant, index) => normalizeVariant(variant, index, subject))
        .filter((variant): variant is ComposeVariant => Boolean(variant))
        .slice(0, MAX_VARIANTS);
    if (variants.length === 0) return null;
    return {
        schemaVersion: 'compose-block-v1',
        kind,
        title: asText(obj['title'], MAX_TITLE) || 'Draft',
        subject,
        variants,
    };
}

export function renderComposeBlockPlaceholder(raw: string): string {
    const encoded = encodeURIComponent(raw);
    return `<div class="compose-block-pending" data-compose-block-kind="compose-block" data-compose-block-spec="${escapeAttr(encoded)}" role="status" aria-label="Compose block loading">
        <div class="compose-loading">초안을 준비하는 중...</div>
    </div>`;
}

function getPendingBlocks(root: ParentNode): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches(PENDING_SELECTOR)) blocks.push(root);
    blocks.push(...Array.from(root.querySelectorAll<HTMLElement>(PENDING_SELECTOR)));
    return blocks;
}

function getRestorableBlocks(root: ParentNode): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    const selector = `${BLOCK_SELECTOR}[data-compose-block-spec]`;
    if (root instanceof HTMLElement && root.matches(selector)) blocks.push(root);
    blocks.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)));
    return blocks;
}

function kindLabel(kind: ComposeKind): string {
    if (kind === 'email') return 'Email';
    if (kind === 'message') return 'Message';
    if (kind === 'document') return 'Document';
    return 'Draft';
}

function subjectFieldLabel(kind: ComposeKind): string {
    if (kind === 'document') return 'Title';
    if (kind === 'message') return 'Topic';
    return 'Subject';
}

function renderTabs(spec: ComposeBlockSpec): string {
    return spec.variants.map((variant, index) => `<button class="compose-tab${index === 0 ? ' is-active' : ''}" type="button" data-compose-action="variant" data-variant-id="${escapeAttr(variant.id)}" aria-pressed="${index === 0 ? 'true' : 'false'}">${escapeHtml(variant.label)}</button>`).join('');
}

function renderBlock(spec: ComposeBlockSpec): string {
    const first = spec.variants[0]!;
    const protocolButton = spec.kind === 'email'
        ? '<button class="compose-btn" type="button" data-compose-action="mail">Open in Mail</button>'
        : spec.kind === 'message'
            ? '<button class="compose-btn" type="button" data-compose-action="sms">Open in Messages</button>'
            : '';
    return `
        <div class="compose-block-header">
            <div class="compose-title">${escapeHtml(spec.title)}</div>
            <div class="compose-kind">${escapeHtml(kindLabel(spec.kind))}</div>
        </div>
        <label class="compose-subject-row">
            <span>${escapeHtml(subjectFieldLabel(spec.kind))}</span>
            <input class="compose-subject-input" type="text" value="${escapeAttr(first.subject || spec.subject)}" maxlength="${MAX_SUBJECT}">
        </label>
        <div class="compose-tabs" role="group" aria-label="Draft variants">${renderTabs(spec)}</div>
        <textarea class="compose-body" rows="8" maxlength="${MAX_BODY}">${escapeHtml(first.body)}</textarea>
        <div class="compose-actions">
            <button class="compose-btn" type="button" data-compose-action="copy">Copy</button>
            ${protocolButton}
        </div>
        <div class="compose-followup">
            <label class="compose-followup-row">
                <span>Prompt</span>
                <textarea class="compose-followup-input" rows="2" maxlength="${MAX_FOLLOWUP}" placeholder="추가 요청을 입력하세요. Cmd/Ctrl+Enter로 보낼 수 있습니다."></textarea>
            </label>
            <div class="compose-followup-actions">
                <div class="compose-followup-error" role="alert" aria-live="polite"></div>
                <button class="compose-btn compose-send-btn" type="button" data-compose-action="send-followup">Send</button>
            </div>
        </div>`;
}

export function hydrateComposeBlocks(root: ParentNode = document): void {
    for (const block of getPendingBlocks(root)) {
        if (block.dataset['composeBlockHydrated'] === 'true') continue;
        block.dataset['composeBlockHydrated'] = 'true';
        const spec = readSpecFromBlock(block);
        if (!spec) {
            console.warn('[compose-block] invalid compose block spec');
            delete block.dataset['composeBlockSpec'];
            block.className = 'compose-block compose-error';
            block.innerHTML = '<div class="compose-error-text">초안 형식을 읽을 수 없습니다. compose-block은 strict JSON이어야 하며 문자열 안 줄바꿈은 \\n으로 escape해야 합니다.</div>';
            continue;
        }
        block.className = 'compose-block';
        block.dataset['composeBlockSpec'] = encodeSpec(spec);
        blockSpecs.set(block, spec);
        block.innerHTML = renderBlock(spec);
    }
    for (const block of getRestorableBlocks(root)) {
        if (blockSpecs.has(block)) continue;
        const spec = readSpecFromBlock(block);
        if (spec) blockSpecs.set(block, spec);
    }
}

function findBlock(target: EventTarget | null): HTMLElement | null {
    return target instanceof HTMLElement ? target.closest<HTMLElement>(BLOCK_SELECTOR) : null;
}

function currentText(block: HTMLElement): { subject: string; body: string } {
    return {
        subject: block.querySelector<HTMLInputElement>('.compose-subject-input')?.value || '',
        body: block.querySelector<HTMLTextAreaElement>('.compose-body')?.value || '',
    };
}

function currentFollowup(block: HTMLElement): string {
    const raw = block.querySelector<HTMLTextAreaElement>('.compose-followup-input')?.value || '';
    const text = raw.trim();
    return text.length > MAX_FOLLOWUP ? text.slice(0, MAX_FOLLOWUP) : text;
}

function setFollowupNotice(block: HTMLElement, message: string, kind: 'error' | 'success' = 'error'): void {
    const notice = block.querySelector<HTMLElement>('.compose-followup-error');
    if (!notice) return;
    notice.textContent = message;
    notice.dataset['state'] = message ? kind : '';
}

function createInputEvent(input: Element, type: string): Event {
    const eventCtor = input.ownerDocument.defaultView?.Event || Event;
    return new eventCtor(type, { bubbles: true });
}

function composeFollowupPrompt(spec: ComposeBlockSpec, subject: string, body: string, instruction: string): string {
    const fieldLabel = subjectFieldLabel(spec.kind);
    return [
        '다음 compose-block 초안을 사용자가 편집했습니다.',
        '',
        `종류: ${kindLabel(spec.kind)}`,
        `카드 제목: ${spec.title}`,
        '',
        `${fieldLabel}:`,
        subject || '(비어 있음)',
        '',
        '본문:',
        body || '(비어 있음)',
        '',
        '사용자 추가 요청:',
        instruction,
        '',
        '위 수정본과 추가 요청을 반영해서 새 compose-block 초안을 다시 작성해주세요. 결과는 strict JSON compose-block으로 반환하고, 멀티라인 본문은 variants[].paragraphs 또는 variants[].bodyLines 배열을 우선 사용해주세요.',
    ].join('\n');
}

function submitFollowup(block: HTMLElement, spec: ComposeBlockSpec): void {
    const instruction = currentFollowup(block);
    if (!instruction) {
        setFollowupNotice(block, '추가 요청을 입력한 뒤 Send를 눌러주세요.');
        block.querySelector<HTMLTextAreaElement>('.compose-followup-input')?.focus();
        return;
    }
    const input = document.getElementById('chatInput') as HTMLTextAreaElement | HTMLInputElement | null;
    if (!input) {
        setFollowupNotice(block, '채팅 입력창을 찾을 수 없습니다.');
        return;
    }
    if (!canSendFromCurrentView()) {
        showReadOnlySwitchAffordance();
        setFollowupNotice(block, t('sessionReadonly.composeRejected'));
        return;
    }
    const { subject, body } = currentText(block);
    input.value = composeFollowupPrompt(spec, subject, body, instruction);
    input.dispatchEvent(createInputEvent(input, 'input'));
    input.dispatchEvent(createInputEvent(input, 'cmd-execute'));
    const followup = block.querySelector<HTMLTextAreaElement>('.compose-followup-input');
    if (followup) followup.value = '';
    setFollowupNotice(block, '전송했습니다.', 'success');
}

function setVariant(block: HTMLElement, variantId: string): void {
    const spec = blockSpecs.get(block);
    if (!spec) return;
    const variant = spec?.variants.find(item => item.id === variantId);
    if (!variant) return;
    const subject = block.querySelector<HTMLInputElement>('.compose-subject-input');
    const body = block.querySelector<HTMLTextAreaElement>('.compose-body');
    if (subject) subject.value = variant.subject || spec.subject;
    if (body) body.value = variant.body;
    for (const tab of block.querySelectorAll<HTMLButtonElement>('.compose-tab')) {
        const active = tab.dataset['variantId'] === variantId;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-pressed', String(active));
    }
}

async function copyText(text: string): Promise<void> {
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
        await clipboard.writeText(text);
        return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
}

function protocolOpen(url: string): void {
    window.location.href = url;
}

function handleClick(event: MouseEvent): void {
    const actionEl = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-compose-action]')
        : null;
    if (!actionEl) return;
    const block = findBlock(actionEl);
    const spec = block ? blockSpecs.get(block) : null;
    if (!block || !spec) return;
    event.preventDefault();
    const action = actionEl.dataset['composeAction'];
    const { subject, body } = currentText(block);
    if (action === 'variant') setVariant(block, actionEl.dataset['variantId'] || '');
    if (action === 'copy') void copyText(subject ? `${subject}\n\n${body}` : body);
    if (action === 'mail') protocolOpen(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    if (action === 'sms') protocolOpen(`sms:?body=${encodeURIComponent(body)}`);
    if (action === 'send-followup') submitFollowup(block, spec);
}

function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains('compose-followup-input')) return;
    const block = findBlock(target);
    const spec = block ? blockSpecs.get(block) : null;
    if (!block || !spec) return;
    event.preventDefault();
    submitFollowup(block, spec);
}

export function ensureComposeBlockDelegation(): void {
    if (delegatedDocument === document) return;
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeydown);
    delegatedDocument = document;
}
