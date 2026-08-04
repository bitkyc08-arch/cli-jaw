import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

function read(path: string): string {
    return readFileSync(join(import.meta.dirname, '../..', path), 'utf8');
}

const chatSource = read('public/js/features/chat.ts');
const composeSource = read('public/js/render/compose-block.ts');
const elicitationSource = read('public/js/features/elicitation.ts');

const onResponse = {
    active: 'default',
    sessions: [
        { id: 'default', seq: 0, label: null, message_count: 1, source: 'local' as const, remoteKey: null, lastActivityAt: null },
        { id: 'local-1', seq: 1, label: 'Local one', message_count: 2, source: 'local' as const, remoteKey: null, lastActivityAt: null },
    ],
};

test.afterEach(() => {
    resetWebUiDom();
});

test('guard owns all seven write entry points and runs before stop, preview relay, and voice mutation', () => {
    const sendStart = chatSource.indexOf('export async function sendMessage');
    const sendGuard = chatSource.indexOf('canSendFromCurrentView', sendStart);
    const stopBranch = chatSource.indexOf("btn.classList.contains('stop-mode')", sendStart);
    const relay = chatSource.indexOf('postChatMessage(text)', sendStart);
    const voiceStart = chatSource.indexOf('export async function sendVoiceToServer');
    const voiceGuard = chatSource.indexOf('canSendFromCurrentView', voiceStart);
    const voiceMutation = chatSource.indexOf("document.getElementById('chatInput')", voiceStart);

    assert.ok(sendGuard > sendStart && sendGuard < stopBranch, 'send guard must precede the global stop branch');
    assert.ok(sendGuard < relay, 'send guard must precede the normal/preview message path');
    assert.ok(voiceGuard > voiceStart && voiceGuard < voiceMutation, 'voice guard must precede UI, STT, and upload work');

    const entryPointEvidence = [
        ['normal send and preview relay', /postChatMessage\(text\)/],
        ['retry message admission', /apiJson\('\/api\/message', 'POST', \{ prompt: originalText \}\)/],
        ['slash steer fallback', /result\?\.steerPrompt[\s\S]*apiJson\('\/api\/message'/],
        ['attachments', /state\.attachedFiles\.length[\s\S]*uploadFile/],
        ['voice', /sendVoiceToServer[\s\S]*\/api\/voice/],
        ['slash command', /postSlashCommand\(text\)/],
        ['stop', /apiFire\('\/api\/stop'/],
    ] as const;
    for (const [name, pattern] of entryPointEvidence) {
        assert.match(chatSource, pattern, `${name} must remain behind one of the two mandatory guards`);
    }
    assert.equal((chatSource.match(/if \(!canSendFromCurrentView/g) || []).length, 2);
});

test('shared predicate preserves OFF behavior, blocks inactive and remote-active views, and passes the allow-list', async () => {
    setupWebUiDom();
    const { canSendFromCurrentView, configureSessionView, currentSessionId, withCurrentSessionQuery } = await import('../../public/js/features/session-hub.ts');

    const offResponse = {
        active: 'default',
        sessions: [{ id: 'default', seq: 0, label: null, message_count: 0 }],
    };
    assert.equal(configureSessionView(offResponse, '/'), 'off');
    assert.equal(canSendFromCurrentView('/help'), true);
    assert.equal(withCurrentSessionQuery('/api/messages/count'), '/api/messages/count');

    assert.equal(configureSessionView(onResponse, '/1'), 'session');
    assert.equal(currentSessionId(), 'local-1');
    assert.equal(canSendFromCurrentView('hello'), false);
    assert.equal(withCurrentSessionQuery('?limit=3000'), '?limit=3000&session=local-1');
    assert.equal(withCurrentSessionQuery('/api/messages/count'), '/api/messages/count?session=local-1');
    for (const allowed of ['/switch 1', '/1', '/sessions', '/fork local copy']) {
        assert.equal(canSendFromCurrentView(allowed), true, `${allowed} must remain available as an escape route`);
    }

    const remoteActive = {
        active: 'remote-2',
        sessions: [{ id: 'remote-2', seq: 2, label: 'Slack', message_count: 3, source: 'slack' as const, remoteKey: 'jaw:slack:channel:C1', lastActivityAt: null }],
    };
    configureSessionView(remoteActive, '/2');
    assert.equal(canSendFromCurrentView('hello'), false, 'remote binding must win over active-session equality');
});

test('entering a read-only route synchronously cancels an in-flight recording', async () => {
    setupWebUiDom();
    const { configureSessionView, initializeSessionView } = await import('../../public/js/features/session-hub.ts');
    let cancelled = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
        if (String(input).includes('/api/auth/token')) return new Response(JSON.stringify({ token: '' }), { headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true, data: onResponse }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
        await initializeSessionView({ cancelRecording: () => { cancelled += 1; } });
        configureSessionView(onResponse, '/1');
        assert.equal(cancelled, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('normal, retry, slash fallback, attachment, command, stop, and voice attempts cause no admission in read-only view', async () => {
    setupWebUiDom();
    const input = document.createElement('textarea');
    input.id = 'chatInput';
    const send = document.getElementById('btnSend') as HTMLButtonElement;
    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';
    inputArea.append(input, send);
    document.querySelector('.chat-area')?.append(inputArea);

    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (request: string | URL | Request) => {
        requests.push(String(request));
        return new Response(JSON.stringify({ ok: true, data: {} }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
        const sessionView = await import('../../public/js/features/session-hub.ts');
        sessionView.configureSessionView(onResponse, '/1');
        const { state } = await import('../../public/js/state.ts');
        mock.module(join(import.meta.dirname, '../../public/js/provider-icons.js'), {
            exports: {
                providerIcon: () => '',
                providerLabel: (value: string) => value,
                hydrateProviderIcons: () => {},
            },
        });
        const { sendMessage, sendVoiceToServer } = await import('../../public/js/features/chat.ts');
        requests.length = 0;

        const textAttempts = [
            ['normal', 'hello'],
            ['retry', 'retry the original response'],
            ['slash steer fallback', '/unknown-command'],
            ['slash command', '/help'],
        ] as const;
        for (const [, text] of textAttempts) {
            input.value = text;
            await sendMessage('enter');
            assert.equal(input.value, text);
        }

        state.attachedFiles = [{ name: 'evidence.txt' } as File];
        input.value = 'attachment prompt';
        await sendMessage('enter');
        assert.equal(state.attachedFiles.length, 1);

        send.classList.add('stop-mode');
        input.value = '/switch 1';
        await sendMessage('button');
        assert.equal(send.classList.contains('stop-mode'), true);

        input.value = 'voice context';
        await sendVoiceToServer(new Blob(['voice']), '.webm', 'audio/webm');
        assert.equal(input.value, 'voice context');
        assert.equal(requests.length, 0, 'no preview relay, command, stop, STT, upload, or message admission may occur');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('compose-block rejection is visible, keeps the draft, and never claims it was sent', async () => {
    setupWebUiDom();
    const input = document.createElement('textarea');
    input.id = 'chatInput';
    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';
    inputArea.appendChild(input);
    document.querySelector('.chat-area')?.append(inputArea);
    let dispatched = 0;
    input.addEventListener('cmd-execute', () => { dispatched += 1; });

    const sessionView = await import('../../public/js/features/session-hub.ts');
    sessionView.configureSessionView(onResponse, '/1');
    const { renderComposeBlockPlaceholder, hydrateComposeBlocks } = await import('../../public/js/render/compose-block.ts');
    const spec = JSON.stringify({
        schemaVersion: 'compose-block-v1', kind: 'email', title: 'Follow up', subject: 'Subject',
        variants: [{ id: 'one', label: 'One', subject: 'Subject', body: 'Body' }],
    });
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderComposeBlockPlaceholder(spec);
    document.body.appendChild(wrapper);
    hydrateComposeBlocks(wrapper);
    const followup = wrapper.querySelector<HTMLTextAreaElement>('.compose-followup-input')!;
    followup.value = 'Keep this draft';
    wrapper.querySelector<HTMLButtonElement>('[data-compose-action="send-followup"]')?.click();

    assert.equal(dispatched, 0);
    assert.equal(followup.value, 'Keep this draft');
    assert.notEqual(wrapper.querySelector<HTMLElement>('.compose-followup-error')?.dataset['state'], 'success');
    assert.doesNotMatch(wrapper.textContent || '', /전송했습니다/);
});

test('elicitation rejection stays interactive and never renders completed state', async () => {
    setupWebUiDom();
    const input = document.createElement('textarea');
    input.id = 'chatInput';
    const inputArea = document.createElement('div');
    inputArea.className = 'chat-input-area';
    inputArea.appendChild(input);
    document.querySelector('.chat-area')?.append(inputArea);
    let dispatched = 0;
    input.addEventListener('cmd-execute', () => { dispatched += 1; });

    const sessionView = await import('../../public/js/features/session-hub.ts');
    sessionView.configureSessionView(onResponse, '/1');
    const { renderElicitationPlaceholder, hydrateElicitationBlocks, ensureElicitationDelegation } = await import('../../public/js/features/elicitation.ts');
    const spec = JSON.stringify({ questions: [{ id: 'scope', question: 'Scope?', type: 'single_select', options: [{ id: 'one', label: 'One', value: 'one' }] }] });
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderElicitationPlaceholder(spec, 'elicitation');
    document.body.appendChild(wrapper);
    hydrateElicitationBlocks(wrapper);
    ensureElicitationDelegation();
    wrapper.querySelector<HTMLButtonElement>('.elicitation-option')?.click();

    assert.equal(dispatched, 0);
    assert.equal(wrapper.querySelector('.elicitation-complete'), null);
    assert.ok(wrapper.querySelector('.elicitation-option'), 'the rejected block must remain interactive');
    assert.notEqual(wrapper.querySelector<HTMLElement>('.elicitation-block')?.dataset['elicitationState'], 'submitting');
    assert.ok(wrapper.querySelector('.elicitation-readonly-notice'));
});

test('render dispatchers call the synchronous shared predicate before mutation or SUBMITTING_STATE', () => {
    const composeGuard = composeSource.indexOf('if (!canSendFromCurrentView())');
    assert.ok(composeGuard > 0 && composeGuard < composeSource.indexOf('input.value = composeFollowupPrompt'));
    assert.ok(composeGuard < composeSource.indexOf("input.dispatchEvent(createInputEvent(input, 'cmd-execute'))"));

    const elicitationGuard = elicitationSource.indexOf('if (!canSendFromCurrentView())');
    const submittingAssignment = elicitationSource.indexOf("block.dataset['elicitationState'] = SUBMITTING_STATE");
    assert.ok(elicitationGuard > 0 && elicitationGuard < submittingAssignment);
    assert.ok(elicitationSource.indexOf('renderSubmittedSummary', submittingAssignment) > submittingAssignment);
});
