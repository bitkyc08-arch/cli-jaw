import {
    completionKeyForBlock,
    isElicitationCompleted,
    markElicitationCompleted,
    parseElicitationSpec,
    type NormalizedOption,
    type NormalizedQuestion,
    type NormalizedSpec,
} from './elicitation-state.js';
import { escapeHtml } from '../render/html.js';

type ElicitationKind = 'elicitation' | 'choice-buttons';

interface ElicitationAnswer {
    question: NormalizedQuestion;
    skipped: boolean;
    values: string[];
    labels: string[];
}

interface ElicitationState {
    spec: NormalizedSpec;
    index: number;
    answers: ElicitationAnswer[];
}

const PENDING_SELECTOR = '.elicitation-pending';
const BLOCK_SELECTOR = '.elicitation-block';
const SUBMITTING_STATE = 'submitting';
const DEFAULT_FINAL_INSTRUCTION = '위 응답을 기준으로 계속 진행해줘.';

const blockStates = new WeakMap<HTMLElement, ElicitationState>();
let delegatedDocument: Document | null = null;
let blockSequence = 0;

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderElicitationPlaceholder(raw: string, kind: ElicitationKind): string {
    const encoded = encodeURIComponent(raw);
    return `<div class="elicitation-pending" data-elicitation-kind="${escapeAttr(kind)}" data-elicitation-spec="${escapeAttr(encoded)}" role="status" aria-label="Structured question loading">
        <div class="elicitation-loading">질문을 준비하는 중...</div>
    </div>`;
}

function getAllPendingBlocks(root: ParentNode): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    if (root instanceof HTMLElement && root.matches(PENDING_SELECTOR)) blocks.push(root);
    blocks.push(...Array.from(root.querySelectorAll<HTMLElement>(PENDING_SELECTOR)));
    return blocks;
}

export function hydrateElicitationBlocks(root: ParentNode = document): void {
    for (const block of getAllPendingBlocks(root)) {
        if (block.dataset['elicitationHydrated'] === 'true') continue;
        const encoded = block.dataset['elicitationSpec'] || '';
        let decoded = '';
        try {
            decoded = decodeURIComponent(encoded);
        } catch {
            decoded = '';
        }
        const parsed = parseElicitationSpec(decoded);
        block.dataset['elicitationHydrated'] = 'true';
        if (!parsed) {
            console.warn('[elicitation] invalid structured question spec', {
                kind: block.dataset['elicitationKind'] || '',
                decodedChars: decoded.length,
                reason: decoded ? 'parse_or_normalize_failed' : 'empty_spec',
            });
            block.className = 'elicitation-block elicitation-error';
            block.innerHTML = '<div class="elicitation-error-text">질문 형식을 읽을 수 없습니다.</div>';
            continue;
        }
        const completionKey = completionKeyForBlock(block, parsed);
        block.dataset['elicitationCompletionKey'] = completionKey || '';
        if (isElicitationCompleted(completionKey)) {
            renderSubmittedSummary(block);
            continue;
        }
        const state: ElicitationState = { spec: parsed, index: 0, answers: [] };
        blockStates.set(block, state);
        advanceToNextVisibleQuestion(block, state);
    }
}

function renderCurrentQuestion(block: HTMLElement): void {
    const state = blockStates.get(block);
    if (!state) return;
    const question = state.spec.questions[state.index];
    if (!question) {
        submitComposedPrompt(block, state);
        return;
    }
    const total = state.spec.questions.length;
    const blockId = block.id || `elicitation-${++blockSequence}`;
    block.id = blockId;
    block.className = 'elicitation-block';
    block.dataset['elicitationState'] = 'active';
    block.innerHTML = `
        <div class="elicitation-top">
            <div class="elicitation-progress">Q${state.index + 1} ${state.index + 1}/${total}</div>
            <button class="elicitation-skip" type="button" data-elicitation-action="skip">skip</button>
        </div>
        <div class="elicitation-question" id="${escapeAttr(blockId)}-question">${escapeHtml(question.question)}</div>
        <div class="elicitation-options" role="group" aria-labelledby="${escapeAttr(blockId)}-question">
            ${question.options.map(option => renderOption(question, option)).join('')}
        </div>
        ${question.type === 'multi_select' ? '<button class="elicitation-submit" type="button" data-elicitation-action="submit-multi">선택 완료</button>' : ''}
        <div class="elicitation-input-row">
            <input class="elicitation-input" type="text" placeholder="직접 입력" aria-label="직접 입력">
            <button class="elicitation-submit" type="button" data-elicitation-action="submit-custom">입력</button>
        </div>`;
}

function renderOption(question: NormalizedQuestion, option: NormalizedOption): string {
    const pressed = question.type === 'multi_select' ? ' aria-pressed="false"' : '';
    const description = option.description ? `<span class="elicitation-option-description">${escapeHtml(option.description)}</span>` : '';
    return `<button class="elicitation-option" type="button" data-elicitation-action="select-option" data-option-id="${escapeAttr(option.id)}"${pressed}>
        <span class="elicitation-option-label">${escapeHtml(option.label)}</span>${description}
    </button>`;
}

function findBlock(target: EventTarget | null): HTMLElement | null {
    return target instanceof HTMLElement ? target.closest<HTMLElement>(BLOCK_SELECTOR) : null;
}

function currentQuestion(state: ElicitationState): NormalizedQuestion | null {
    return state.spec.questions[state.index] || null;
}

function currentOption(state: ElicitationState, optionId: string): NormalizedOption | null {
    const question = currentQuestion(state);
    return question?.options.find(option => option.id === optionId) || null;
}

function buildAnswersByQuestionId(state: ElicitationState): Map<string, ElicitationAnswer> {
    const answers = new Map<string, ElicitationAnswer>();
    for (const answer of state.answers) {
        if (answer) answers.set(answer.question.id, answer);
    }
    return answers;
}

function isQuestionVisible(question: NormalizedQuestion, answersByQuestionId: Map<string, ElicitationAnswer>): boolean {
    for (const [questionId, allowedValues] of Object.entries(question.visibleWhen)) {
        const answer = answersByQuestionId.get(questionId);
        if (!answer || answer.skipped) return false;
        if (!answer.values.some(value => allowedValues.includes(value))) return false;
    }
    return true;
}

function advanceToNextVisibleQuestion(block: HTMLElement, state: ElicitationState): void {
    while (state.index < state.spec.questions.length) {
        const question = currentQuestion(state);
        if (!question) break;
        if (isQuestionVisible(question, buildAnswersByQuestionId(state))) break;
        state.index += 1;
    }
    renderCurrentQuestion(block);
}

function recordAnswer(block: HTMLElement, answer: Omit<ElicitationAnswer, 'question'>): void {
    const state = blockStates.get(block);
    const question = state ? currentQuestion(state) : null;
    if (!state || !question || block.dataset['elicitationState'] === SUBMITTING_STATE) return;
    state.answers[state.index] = { question, ...answer };
    state.index += 1;
    advanceToNextVisibleQuestion(block, state);
}

function handleSelectOption(button: HTMLElement, block: HTMLElement, state: ElicitationState): void {
    const option = currentOption(state, button.dataset['optionId'] || '');
    const question = currentQuestion(state);
    if (!option || !question) return;
    if (question.type === 'multi_select') {
        const nextPressed = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(nextPressed));
        button.classList.toggle('is-selected', nextPressed);
        return;
    }
    recordAnswer(block, {
        skipped: false,
        values: [option.value],
        labels: [option.submitText || option.label],
    });
}

function handleSubmitMulti(block: HTMLElement, state: ElicitationState): void {
    const selected = Array.from(block.querySelectorAll<HTMLElement>('.elicitation-option[aria-pressed="true"]'))
        .map(button => currentOption(state, button.dataset['optionId'] || ''))
        .filter((option): option is NormalizedOption => Boolean(option));
    if (selected.length === 0) return;
    recordAnswer(block, {
        skipped: false,
        values: selected.map(option => option.value),
        labels: selected.map(option => option.submitText || option.label),
    });
}

function handleSubmitCustom(block: HTMLElement): void {
    const input = block.querySelector<HTMLInputElement>('.elicitation-input');
    const value = input?.value.trim() || '';
    if (!value) {
        input?.focus();
        return;
    }
    recordAnswer(block, { skipped: false, values: [value], labels: [value] });
}

function handleClick(event: MouseEvent): void {
    const actionEl = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-elicitation-action]')
        : null;
    if (!actionEl) return;
    const block = findBlock(actionEl);
    const state = block ? blockStates.get(block) : null;
    if (!block || !state || block.dataset['elicitationState'] === SUBMITTING_STATE) return;
    event.preventDefault();
    const action = actionEl.dataset['elicitationAction'];
    if (action === 'select-option') handleSelectOption(actionEl, block, state);
    if (action === 'submit-multi') handleSubmitMulti(block, state);
    if (action === 'submit-custom') handleSubmitCustom(block);
    if (action === 'skip') recordAnswer(block, { skipped: true, values: [], labels: ['skip'] });
}

function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.tagName !== 'INPUT' || !target.classList.contains('elicitation-input')) return;
    const block = findBlock(target);
    if (!block) return;
    event.preventDefault();
    handleSubmitCustom(block);
}

function answeredQuestions(answers: ElicitationAnswer[]): ElicitationAnswer[] {
    return answers.filter((answer): answer is ElicitationAnswer => Boolean(answer));
}

function composePrompt(answers: ElicitationAnswer[]): string {
    const lines = answeredQuestions(answers).map(answer => {
        const label = answer.skipped ? 'skip' : answer.labels.join(', ');
        const values = answer.values.length > 0 ? ` (값: ${answer.values.join(', ')})` : '';
        return `- ${answer.question.question}: ${label}${values}`;
    });
    return `구조화 질문 응답:\n\n${lines.join('\n')}\n\n${DEFAULT_FINAL_INSTRUCTION}`;
}

function renderSubmittedSummary(block: HTMLElement): void {
    block.className = 'elicitation-block elicitation-complete';
    block.dataset['elicitationState'] = 'complete';
    block.innerHTML = '<div class="elicitation-complete-row"><button class="elicitation-complete-button" type="button" disabled>응답 완료</button></div>';
}

function createInputEvent(input: Element, type: string): Event {
    const eventCtor = input.ownerDocument.defaultView?.Event || Event;
    return new eventCtor(type, { bubbles: true });
}

function submitComposedPrompt(block: HTMLElement, state: ElicitationState): void {
    if (block.dataset['elicitationState'] === SUBMITTING_STATE) return;
    block.dataset['elicitationState'] = SUBMITTING_STATE;
    const input = document.getElementById('chatInput') as HTMLTextAreaElement | HTMLInputElement | null;
    if (!input) {
        block.classList.add('elicitation-error');
        block.innerHTML = '<div class="elicitation-error-text">입력창을 찾을 수 없습니다.</div>';
        return;
    }
    input.value = composePrompt(state.answers);
    input.dispatchEvent(createInputEvent(input, 'input'));
    input.dispatchEvent(createInputEvent(input, 'cmd-execute'));
    markElicitationCompleted(block.dataset['elicitationCompletionKey'] || null);
    blockStates.delete(block);
    renderSubmittedSummary(block);
}

export function ensureElicitationDelegation(): void {
    if (delegatedDocument === document) return;
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKeydown);
    delegatedDocument = document;
}
