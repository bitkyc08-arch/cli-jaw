import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

function read(path: string): string {
    return readFileSync(join(import.meta.dirname, '../..', path), 'utf8');
}

const markdownSrc = read('public/js/render/markdown.ts');
const sanitizeSrc = read('public/js/render/sanitize.ts');
const postRenderSrc = read('public/js/render/post-render.ts');
const delegationsSrc = read('public/js/render/delegations.ts');
const messageHistorySrc = read('public/js/features/message-history.ts');
const chatMessagesSrc = read('public/js/features/chat-messages.ts');
const elicitationSrc = read('public/js/features/elicitation.ts');
const elicitationStateSrc = read('public/js/features/elicitation-state.ts');
const idbCacheSrc = read('public/js/features/idb-cache.ts');
const messageItemHtmlSrc = read('public/js/features/message-item-html.ts');
const uiSrc = read('public/js/ui.ts');

test.afterEach(() => {
    resetWebUiDom();
});

test('renderer maps elicitation and choice-buttons fences to sanitizer-safe placeholders', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');

    const spec = JSON.stringify({
        questions: [{
            id: 'scope',
            question: '구현 범위는?',
            type: 'single_select',
            options: [{ id: 'mvp', label: 'MVP', value: 'single_select MVP' }],
        }],
    });
    const elicitationHtml = renderMarkdown(`\`\`\`elicitation\n${spec}\n\`\`\``);
    const aliasHtml = renderMarkdown(`\`\`\`choice-buttons\n${JSON.stringify({ question: '선택?', options: ['A', 'B'] })}\n\`\`\``);

    assert.match(elicitationHtml, /class="elicitation-pending"/);
    assert.match(elicitationHtml, /data-elicitation-kind="elicitation"/);
    assert.match(elicitationHtml, /data-elicitation-spec="/);
    assert.doesNotMatch(elicitationHtml, /<pre><code/);
    assert.doesNotMatch(elicitationHtml, /"questions"/);

    assert.match(aliasHtml, /class="elicitation-pending"/);
    assert.match(aliasHtml, /data-elicitation-kind="choice-buttons"/);
});

test('streaming render keeps structured fences inert until final render', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const spec = JSON.stringify({
        questions: [{ question: '선택?', options: ['A', 'B'] }],
    });

    const streamingHtml = renderMarkdown(`\`\`\`elicitation\n${spec}\n\`\`\``, true);
    const finalHtml = renderMarkdown(`\`\`\`elicitation\n${spec}\n\`\`\``);

    assert.doesNotMatch(streamingHtml, /class="elicitation-pending"/);
    assert.doesNotMatch(streamingHtml, /질문 형식을 읽을 수 없습니다/);
    assert.match(streamingHtml, /<pre><code/);
    assert.match(finalHtml, /class="elicitation-pending"/);
});

test('incomplete structured fence remains inert and does not render parse-error widget', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const truncated = '```elicitation\n{"questions":[{"id":"q","question":"unfinished';

    const streamingHtml = renderMarkdown(truncated, true);
    const finalHtml = renderMarkdown(truncated);

    assert.doesNotMatch(streamingHtml, /class="elicitation-pending"/);
    assert.doesNotMatch(streamingHtml, /질문 형식을 읽을 수 없습니다/);
    assert.doesNotMatch(finalHtml, /class="elicitation-pending"/);
    assert.doesNotMatch(finalHtml, /질문 형식을 읽을 수 없습니다/);
});

test('malformed final structured spec fails closed with developer diagnostic', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateElicitationBlocks } = await import('../../public/js/features/elicitation.ts');
    const wrapper = document.createElement('div');
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        wrapper.innerHTML = renderMarkdown('```elicitation\nnot-json\n```');
        document.body.appendChild(wrapper);
        hydrateElicitationBlocks(wrapper);
    } finally {
        console.warn = originalWarn;
    }

    assert.match(wrapper.innerHTML, /질문 형식을 읽을 수 없습니다/);
    assert.ok(warnings.some(args => String((args as unknown[])[0]).includes('[elicitation] invalid structured question spec')));
});

test('sanitizer preserves only the placeholder data attributes required for hydration', () => {
    assert.match(sanitizeSrc, /'data-elicitation-kind'/);
    assert.match(sanitizeSrc, /'data-elicitation-spec'/);
    assert.match(sanitizeSrc, /'data-elicitation-hydrated'/);
    assert.match(sanitizeSrc, /FORBID_TAGS:\s*\[[\s\S]*'form'[\s\S]*'input'/);
});

test('hydration is wired through render finalization, live messages, and virtual scroll history', () => {
    assert.match(markdownSrc, /renderElicitationPlaceholder/);
    assert.match(postRenderSrc, /hydrateElicitationBlocks\(msgContainer\)/);
    assert.match(delegationsSrc, /ensureElicitationDelegation\(\)/);
    assert.match(messageHistorySrc, /seedCompletedElicitationsFromMessages\(safeMsgs\)/);
    assert.match(messageHistorySrc, /seedCompletedElicitationsFromMessages\(safeCached\)/);

    // Callback assignment spelling is not wiring behavior. The elicitation
    // first-user/history cases in web-structured-hydration.test.ts drive the
    // public entrypoints, automatic callbacks and real VS disconnect/remount,
    // preserving scoped hydration and exactly one widget without manual setup.

    assert.match(chatMessagesSrc, /hydrateElicitationBlocks\(div\)/);
    assert.match(chatMessagesSrc, /hydrateElicitationBlocks\(viewport\)/);
});

test('completion persistence uses stable turn indexes across history, cache, and virtual promotion', () => {
    assert.match(elicitationStateSrc, /jaw:elicitation:complete/);
    assert.match(elicitationStateSrc, /dataset\['turnIndex'\]/);
    assert.match(elicitationStateSrc, /extractElicitationSpecs/);
    assert.match(elicitationStateSrc, /src\/shared\/elicitation-spec\.js/);
    assert.doesNotMatch(elicitationStateSrc, /function normalizeElicitationSpec/);
    assert.match(elicitationStateSrc, /seedCompletedElicitationsFromMessages/);
    assert.match(messageItemHtmlSrc, /String\(m\.id \?\? generateId\(\)\)/);
    assert.match(idbCacheSrc, /message_id: msg\.message_id \?\? msg\.id/);
    assert.match(uiSrc, /div\.dataset\['turnIndex'\] = String\(vs\.count\)/);
});

test('elicitation feature avoids chat imports and submits through cmd-execute', () => {
    assert.doesNotMatch(elicitationSrc, /from ['"].*chat(?:\.js)?['"]/);
    assert.doesNotMatch(elicitationSrc, /sendMessage/);
    assert.match(elicitationSrc, /cmd-execute/);
    assert.match(elicitationSrc, /data-elicitation-action="skip"/);
    assert.match(elicitationSrc, /data-elicitation-action="submit-custom"/);
    assert.match(elicitationSrc, /SUBMITTING_STATE/);
    assert.match(elicitationSrc, /elicitation-complete/);
    assert.doesNotMatch(elicitationSrc, /block\.remove\(\)/);
});

test('hydrated single-question option click composes a user message and renders compact completed button only', async () => {
    setupWebUiDom();
    const input = document.createElement('textarea');
    input.id = 'chatInput';
    document.body.appendChild(input);

    let sent = 0;
    input.addEventListener('cmd-execute', () => { sent += 1; });

    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateElicitationBlocks } = await import('../../public/js/features/elicitation.ts');
    const spec = {
        questions: [{
            id: 'scope',
            question: '구현 범위',
            type: 'single_select',
            options: [{
                id: 'mvp',
                label: 'single_select MVP',
                value: 'single_select MVP',
                description: '작게 시작',
            }],
        }],
    };
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`elicitation\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateElicitationBlocks(wrapper);

    const option = wrapper.querySelector<HTMLButtonElement>('.elicitation-option');
    assert.ok(option, 'hydration should render an option button');
    option.click();
    option.click();

    assert.equal(sent, 1);
    assert.ok(wrapper.querySelector('.elicitation-complete'), 'completed wizard should stay visible as compact context');
    assert.ok(wrapper.querySelector('.elicitation-complete-button'), 'completed wizard should render a status button');
    assert.match(wrapper.textContent || '', /응답 완료/);
    assert.equal(wrapper.querySelector('.elicitation-option'), null);
    assert.equal(wrapper.querySelector('.elicitation-input'), null);
    assert.equal(wrapper.querySelector('[data-elicitation-action="skip"]'), null);
    assert.doesNotMatch(wrapper.textContent || '', /구현 범위/);
    assert.doesNotMatch(wrapper.textContent || '', /single_select MVP/);
    assert.match(input.value, /구조화 질문 응답:/);
    assert.match(input.value, /- 구현 범위: single_select MVP \(값: single_select MVP\)/);
    assert.match(input.value, /위 응답을 기준으로 계속 진행해줘\./);
});

test('history structured response seed keeps completed elicitation compact after refresh', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateElicitationBlocks } = await import('../../public/js/features/elicitation.ts');
    const { seedCompletedElicitationsFromMessages } = await import('../../public/js/features/elicitation-state.ts');
    const spec = {
        questions: [{
            id: 'scope',
            question: '구현 범위',
            options: [{ id: 'mvp', label: 'MVP', value: 'mvp' }],
        }],
    };
    const assistant = `\`\`\`elicitation\n${JSON.stringify(spec)}\n\`\`\``;
    const user = '구조화 질문 응답:\n\n- 구현 범위: MVP (값: mvp)\n\n위 응답을 기준으로 계속 진행해줘.';
    seedCompletedElicitationsFromMessages([
        { role: 'assistant', content: assistant },
        { role: 'user', content: user },
    ]);

    const msg = document.createElement('div');
    msg.className = 'msg msg-agent';
    msg.dataset['turnIndex'] = '0';
    msg.innerHTML = `<div class="msg-content">${renderMarkdown(assistant)}</div>`;
    document.body.appendChild(msg);
    hydrateElicitationBlocks(msg);

    assert.ok(msg.querySelector('.elicitation-complete-button'));
    assert.match(msg.textContent || '', /응답 완료/);
    assert.equal(msg.querySelector('.elicitation-option'), null);
});

test('completion keys do not collide for identical specs at different turn indexes', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateElicitationBlocks } = await import('../../public/js/features/elicitation.ts');
    const { seedCompletedElicitationsFromMessages } = await import('../../public/js/features/elicitation-state.ts');
    const spec = { questions: [{ question: '선택?', options: ['A', 'B'] }] };
    const assistant = `\`\`\`elicitation\n${JSON.stringify(spec)}\n\`\`\``;
    seedCompletedElicitationsFromMessages([
        { role: 'assistant', content: assistant },
        { role: 'user', content: '구조화 질문 응답:\n\n- 선택?: A (값: A)' },
    ]);

    const first = document.createElement('div');
    first.className = 'msg msg-agent';
    first.dataset['turnIndex'] = '0';
    first.innerHTML = `<div class="msg-content">${renderMarkdown(assistant)}</div>`;
    const second = document.createElement('div');
    second.className = 'msg msg-agent';
    second.dataset['turnIndex'] = '2';
    second.innerHTML = `<div class="msg-content">${renderMarkdown(assistant)}</div>`;
    document.body.append(first, second);
    hydrateElicitationBlocks(document.body);

    assert.ok(first.querySelector('.elicitation-complete-button'));
    assert.equal(second.querySelector('.elicitation-complete-button'), null);
    assert.ok(second.querySelector('.elicitation-option'));
});

test('visibleWhen shows a dependent question when the controlling value matches', async () => {
    setupWebUiDom();
    const input = document.createElement('textarea');
    input.id = 'chatInput';
    document.body.appendChild(input);

    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateElicitationBlocks } = await import('../../public/js/features/elicitation.ts');
    const spec = {
        questions: [
            {
                id: 'work_type',
                question: '작업 종류',
                options: [{ label: '버그 수정', value: 'bug_fix' }, { label: '문서화', value: 'docs' }],
            },
            {
                id: 'repro_path',
                question: '재현 경로',
                visibleWhen: { work_type: ['bug_fix'] },
                options: [{ label: '있음', value: 'has_repro' }],
            },
        ],
    };
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`elicitation\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateElicitationBlocks(wrapper);

    wrapper.querySelectorAll<HTMLButtonElement>('.elicitation-option')[0]?.click();

    assert.match(wrapper.textContent || '', /재현 경로/);
    assert.match(wrapper.textContent || '', /있음/);
});

test('visibleWhen skips non-matching questions and omits them from composed prompt', async () => {
    setupWebUiDom();
    const input = document.createElement('textarea');
    input.id = 'chatInput';
    document.body.appendChild(input);
    let sent = 0;
    input.addEventListener('cmd-execute', () => { sent += 1; });

    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateElicitationBlocks } = await import('../../public/js/features/elicitation.ts');
    const spec = {
        questions: [
            {
                id: 'work_type',
                question: '작업 종류',
                options: [{ label: '버그 수정', value: 'bug_fix' }, { label: '문서화', value: 'docs' }],
            },
            {
                id: 'repro_path',
                question: '재현 경로',
                visibleWhen: { work_type: ['bug_fix'] },
                options: [{ label: '있음', value: 'has_repro' }],
            },
            {
                id: 'priority',
                question: '우선순위',
                options: [{ label: '높음', value: 'high' }],
            },
        ],
    };
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`elicitation\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateElicitationBlocks(wrapper);

    wrapper.querySelectorAll<HTMLButtonElement>('.elicitation-option')[1]?.click();
    assert.doesNotMatch(wrapper.textContent || '', /재현 경로/);
    assert.match(wrapper.textContent || '', /우선순위/);

    wrapper.querySelector<HTMLButtonElement>('.elicitation-option')?.click();

    assert.equal(sent, 1);
    assert.match(input.value, /- 작업 종류: 문서화 \(값: docs\)/);
    assert.match(input.value, /- 우선순위: 높음 \(값: high\)/);
    assert.doesNotMatch(input.value, /재현 경로/);
});

test('visibleWhen is not satisfied when the controlling answer is skipped', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateElicitationBlocks } = await import('../../public/js/features/elicitation.ts');
    const spec = {
        questions: [
            {
                id: 'work_type',
                question: '작업 종류',
                options: [{ label: '버그 수정', value: 'bug_fix' }],
            },
            {
                id: 'repro_path',
                question: '재현 경로',
                visibleWhen: { work_type: ['bug_fix'] },
                options: [{ label: '있음', value: 'has_repro' }],
            },
            {
                id: 'priority',
                question: '우선순위',
                options: [{ label: '높음', value: 'high' }],
            },
        ],
    };
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`elicitation\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateElicitationBlocks(wrapper);

    wrapper.querySelector<HTMLButtonElement>('[data-elicitation-action="skip"]')?.click();

    assert.doesNotMatch(wrapper.textContent || '', /재현 경로/);
    assert.match(wrapper.textContent || '', /우선순위/);
});

test('visibleWhen multi_select controller matches when any selected value is allowed', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateElicitationBlocks } = await import('../../public/js/features/elicitation.ts');
    const spec = {
        questions: [
            {
                id: 'areas',
                question: '영역',
                type: 'multi_select',
                options: [{ label: '문서', value: 'docs' }, { label: '런타임', value: 'runtime' }],
            },
            {
                id: 'runtime_detail',
                question: '런타임 세부',
                visibleWhen: { areas: ['runtime'] },
                options: [{ label: '렌더러', value: 'renderer' }],
            },
        ],
    };
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`elicitation\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateElicitationBlocks(wrapper);

    wrapper.querySelectorAll<HTMLButtonElement>('.elicitation-option')[1]?.click();
    wrapper.querySelector<HTMLButtonElement>('[data-elicitation-action="submit-multi"]')?.click();

    assert.match(wrapper.textContent || '', /런타임 세부/);
    assert.match(wrapper.textContent || '', /렌더러/);
});
