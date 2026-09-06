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
const structuredFenceSrc = read('src/shared/structured-fence.ts');

test.afterEach(() => {
    resetWebUiDom();
});

function composeSpec() {
    return {
        schemaVersion: 'compose-block-v1',
        kind: 'email',
        title: 'Follow up',
        subject: 'Initial subject',
        variants: [
            { id: 'polite', label: 'Polite', subject: 'Polite subject', body: 'Polite body' },
            { id: 'firm', label: 'Firm', subject: 'Firm subject', body: 'Firm body' },
        ],
    };
}

test('compose-block final fence maps to sanitizer-safe placeholder and hides raw JSON', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const html = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``);

    assert.match(html, /class="compose-block-pending"/);
    assert.match(html, /data-compose-block-kind="compose-block"/);
    assert.match(html, /data-compose-block-spec="/);
    assert.doesNotMatch(html, /<pre><code/);
    assert.doesNotMatch(html, /"schemaVersion"/);
});

test('compose-block final fence renders when assistant transport prefixes the opener with a list marker', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`- \`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateComposeBlocks(wrapper);

    assert.ok(wrapper.querySelector('.compose-block'));
    assert.equal(wrapper.querySelector<HTMLInputElement>('.compose-subject-input')?.value, 'Polite subject');
    assert.doesNotMatch(wrapper.innerHTML, /compose-error/);
    assert.doesNotMatch(wrapper.innerHTML, /"schemaVersion"/);
});

test('compose-block streaming fence remains inert until final render', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const markdown = `\`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``;

    assert.match(renderMarkdown(markdown, true), /<pre><code/);
    assert.match(renderMarkdown(markdown), /class="compose-block-pending"/);
});

test('compose-block hydration renders editable controls and variant switching', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateComposeBlocks(wrapper);

    assert.ok(wrapper.querySelector('.compose-block'));
    assert.equal(wrapper.querySelector<HTMLInputElement>('.compose-subject-input')?.value, 'Polite subject');
    assert.equal(wrapper.querySelector<HTMLTextAreaElement>('.compose-body')?.value, 'Polite body');
    wrapper.querySelector<HTMLButtonElement>('[data-variant-id="firm"]')?.click();
    assert.equal(wrapper.querySelector<HTMLInputElement>('.compose-subject-input')?.value, 'Firm subject');
    assert.equal(wrapper.querySelector<HTMLTextAreaElement>('.compose-body')?.value, 'Firm body');
});

test('compose-block copy action uses current edited value', async () => {
    setupWebUiDom();
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { copied = text; } },
    });
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateComposeBlocks(wrapper);

    wrapper.querySelector<HTMLInputElement>('.compose-subject-input')!.value = 'Edited subject';
    wrapper.querySelector<HTMLTextAreaElement>('.compose-body')!.value = 'Edited body';
    wrapper.querySelector<HTMLButtonElement>('[data-compose-action="copy"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(copied, 'Edited subject\n\nEdited body');
});

test('compose-block follow-up sends edited draft through chat input cmd-execute', async () => {
    setupWebUiDom();
    const chatInput = document.createElement('textarea');
    chatInput.id = 'chatInput';
    document.body.appendChild(chatInput);
    let executeCount = 0;
    chatInput.addEventListener('cmd-execute', () => { executeCount += 1; });
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateComposeBlocks(wrapper);

    wrapper.querySelector<HTMLInputElement>('.compose-subject-input')!.value = 'Edited subject';
    wrapper.querySelector<HTMLTextAreaElement>('.compose-body')!.value = 'Edited body';
    wrapper.querySelector<HTMLTextAreaElement>('.compose-followup-input')!.value = 'Make it warmer';
    wrapper.querySelector<HTMLButtonElement>('[data-compose-action="send-followup"]')?.click();

    assert.equal(executeCount, 1);
    assert.match(chatInput.value, /다음 compose-block 초안을 사용자가 편집했습니다/);
    assert.match(chatInput.value, /카드 제목: Follow up/);
    assert.match(chatInput.value, /Subject:\nEdited subject/);
    assert.match(chatInput.value, /본문:\nEdited body/);
    assert.match(chatInput.value, /사용자 추가 요청:\nMake it warmer/);
    assert.match(chatInput.value, /새 compose-block 초안/);
    assert.equal(wrapper.querySelector<HTMLTextAreaElement>('.compose-followup-input')?.value, '');
    assert.equal(wrapper.querySelector<HTMLElement>('.compose-followup-error')?.dataset['state'], 'success');
});

test('compose-block follow-up refuses empty prompt without submitting', async () => {
    setupWebUiDom();
    const chatInput = document.createElement('textarea');
    chatInput.id = 'chatInput';
    document.body.appendChild(chatInput);
    let executeCount = 0;
    chatInput.addEventListener('cmd-execute', () => { executeCount += 1; });
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateComposeBlocks(wrapper);

    wrapper.querySelector<HTMLButtonElement>('[data-compose-action="send-followup"]')?.click();

    assert.equal(executeCount, 0);
    assert.equal(chatInput.value, '');
    assert.match(wrapper.querySelector<HTMLElement>('.compose-followup-error')?.textContent || '', /추가 요청/);
    assert.equal(wrapper.querySelector<HTMLElement>('.compose-followup-error')?.dataset['state'], 'error');
});

test('compose-block follow-up submits on cmd-enter from prompt textarea', async () => {
    setupWebUiDom();
    const chatInput = document.createElement('textarea');
    chatInput.id = 'chatInput';
    document.body.appendChild(chatInput);
    let executeCount = 0;
    chatInput.addEventListener('cmd-execute', () => { executeCount += 1; });
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateComposeBlocks(wrapper);

    const followup = wrapper.querySelector<HTMLTextAreaElement>('.compose-followup-input')!;
    followup.value = 'Shorten this';
    followup.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));

    assert.equal(executeCount, 1);
    assert.match(chatInput.value, /사용자 추가 요청:\nShorten this/);
});

test('compose-block restores action state after virtual-scroll HTML remount', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(composeSpec())}\n\`\`\``);
    document.body.appendChild(wrapper);
    hydrateComposeBlocks(wrapper);

    const serialized = wrapper.innerHTML;
    wrapper.innerHTML = serialized;
    hydrateComposeBlocks(wrapper);

    wrapper.querySelector<HTMLButtonElement>('[data-variant-id="firm"]')?.click();
    assert.equal(wrapper.querySelector<HTMLInputElement>('.compose-subject-input')?.value, 'Firm subject');
    assert.equal(wrapper.querySelector<HTMLTextAreaElement>('.compose-body')?.value, 'Firm body');
});

test('compose-block malformed JSON fails closed with safe local error', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMarkdown('```compose-block\nnot-json\n```');

    hydrateComposeBlocks(wrapper);

    assert.ok(wrapper.querySelector('.compose-error'));
    assert.match(wrapper.textContent || '', /초안 형식을 읽을 수 없습니다/);
    assert.match(wrapper.textContent || '', /strict JSON/);
    assert.doesNotMatch(wrapper.innerHTML, /not-json/);
});

test('compose-block raw newline inside JSON string fails closed with newline guidance', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    const malformed = [
        '{',
        '  "schemaVersion": "compose-block-v1",',
        '  "kind": "document",',
        '  "title": "Bad multiline",',
        '  "variants": [',
        '    {',
        '      "id": "bad",',
        '      "label": "Bad",',
        '      "body": "Line one',
        '',
        'Line two"',
        '    }',
        '  ]',
        '}',
    ].join('\n');
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${malformed}\n\`\`\``);

    hydrateComposeBlocks(wrapper);

    assert.ok(wrapper.querySelector('.compose-error'));
    assert.match(wrapper.textContent || '', /strict JSON/);
    assert.match(wrapper.textContent || '', /\\n/);
    assert.doesNotMatch(wrapper.innerHTML, /Line one/);
});

test('compose-block escaped newline body renders multiline draft text', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    const spec = composeSpec();
    spec.variants = [
        { id: 'multi', label: 'Multiline', subject: 'Multiline subject', body: 'Line one\n\nLine two' },
    ];
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateComposeBlocks(wrapper);

    assert.equal(wrapper.querySelector<HTMLTextAreaElement>('.compose-body')?.value, 'Line one\n\nLine two');
});

test('compose-block paragraphs array renders multiline draft text without newline escapes', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    const spec = {
        schemaVersion: 'compose-block-v1',
        kind: 'document',
        title: 'Paragraphs draft',
        variants: [
            {
                id: 'paragraphs',
                label: 'Paragraphs',
                paragraphs: ['First paragraph.', 'Second paragraph.'],
            },
        ],
    };
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateComposeBlocks(wrapper);

    assert.equal(wrapper.querySelector<HTMLTextAreaElement>('.compose-body')?.value, 'First paragraph.\n\nSecond paragraph.');
});

test('compose-block bodyLines array renders line-separated draft text', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const { hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const wrapper = document.createElement('div');
    const spec = {
        schemaVersion: 'compose-block-v1',
        kind: 'message',
        title: 'Line draft',
        variants: [
            {
                id: 'lines',
                label: 'Lines',
                bodyLines: ['Line one', 'Line two'],
            },
        ],
    };
    wrapper.innerHTML = renderMarkdown(`\`\`\`compose-block\n${JSON.stringify(spec)}\n\`\`\``);
    document.body.appendChild(wrapper);

    hydrateComposeBlocks(wrapper);

    assert.equal(wrapper.querySelector<HTMLTextAreaElement>('.compose-body')?.value, 'Line one\nLine two');
});

// Live/fresh-VS and lazy history hydration, scoped counts and recycling are exercised
// through real entrypoints in web-structured-hydration.test.ts.
test('compose-block parser, sanitizer, delegation and scheduled-finalization contracts remain', () => {
    assert.match(markdownSrc, /renderComposeBlockPlaceholder/);
    assert.match(sanitizeSrc, /'data-compose-block-kind'/);
    assert.match(sanitizeSrc, /'data-compose-block-spec'/);
    assert.match(sanitizeSrc, /'data-compose-block-hydrated'/);
    assert.match(postRenderSrc, /hydrateComposeBlocks\(msgContainer\)/);
    assert.match(delegationsSrc, /ensureComposeBlockDelegation\(\)/);
    assert.match(structuredFenceSrc, /'compose-block'/);
});
