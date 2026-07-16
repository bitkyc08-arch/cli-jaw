import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { InstanceOriginClient } from '../../public/dashboard2/src/providers/api-provider.tsx';
import {
    MAX_ATTACHMENT_BYTES,
    appendAttachmentPaths,
    attachmentIdentity,
    intakeAttachments,
} from '../../public/dashboard2/src/chat/composer/attachments.ts';
import { createComposerRelay } from '../../public/dashboard2/src/chat/composer/composer-bridge.ts';
import { AttachmentUploadError, createSendController } from '../../public/dashboard2/src/chat/composer/send-controller.ts';
import {
    applySlashCommand,
    filterSlashCommands,
    moveMenuIndex,
    slashMatch,
} from '../../public/dashboard2/src/chat/composer/slash-model.ts';

function file(name: string, body = 'x', lastModified = 1): File {
    return new File([body], name, { lastModified, type: 'text/plain' });
}

function client(overrides: Partial<InstanceOriginClient> = {}): InstanceOriginClient {
    return {
        fetchSessions: async () => ({ sessions: [], active: '' }),
        fetchMessagesPage: async () => ({ messages: [], hasMore: false } as never),
        uploadAttachment: async input => ({ path: `/tmp/${input.name}`, filename: input.name }),
        sendMessage: async () => ({ ok: true, action: 'started' }),
        transcribeVoice: async () => ({ ok: true, text: 'hello', engine: 'test', elapsed: 0 }),
        ...overrides,
    };
}

test('046 attachment identity uses name, size, and lastModified', () => {
    const a = file('a.txt', 'same', 10);
    const duplicate = file('a.txt', 'same', 10);
    const changed = file('a.txt', 'same', 11);
    assert.equal(attachmentIdentity(a), attachmentIdentity(duplicate));
    assert.notEqual(attachmentIdentity(a), attachmentIdentity(changed));
    const first = intakeAttachments([], [a]);
    const second = intakeAttachments(first.items, [duplicate, changed]);
    assert.equal(second.duplicateCount, 1);
    assert.equal(second.items.length, 2);
});

test('046 attachment intake keeps oversize rejection on the individual item', () => {
    const oversize = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.bin');
    const result = intakeAttachments([], [oversize]);
    assert.equal(result.items[0]?.status, 'error');
    assert.match(result.items[0]?.error ?? '', /20 MB/);
});

test('046 attachment prompt preserves draft and uploaded paths', () => {
    assert.equal(appendAttachmentPaths('hello', ['/tmp/a', '/tmp/b']), 'hello\n/tmp/a\n/tmp/b');
    assert.equal(appendAttachmentPaths('', ['/tmp/a']), '/tmp/a');
});

test('046 rapid double-submit shares one upload and one message request', async () => {
    let uploads = 0;
    let messages = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const api = client({
        uploadAttachment: async input => { uploads += 1; return { path: `/tmp/${input.name}`, filename: input.name }; },
        sendMessage: async () => { messages += 1; await gate; return { ok: true }; },
    });
    const controller = createSendController(api);
    const attachment = intakeAttachments([], [file('a.txt')]).items[0]!;
    const snapshot = { draft: 'hello', attachments: [attachment], source: 'button' as const };
    const sends = Array.from({ length: 10 }, () => controller.send(snapshot));
    assert.ok(sends.every(promise => promise === sends[0]));
    await new Promise(resolveTick => setImmediate(resolveTick));
    assert.equal(uploads, 1);
    assert.equal(messages, 1);
    release();
    await Promise.all(sends);
});

test('046 failed send clears in-flight gate and retries identical content once', async () => {
    const prompts: string[] = [];
    let fail = true;
    const controller = createSendController(client({
        sendMessage: async prompt => {
            prompts.push(prompt);
            if (fail) { fail = false; throw new Error('500'); }
            return { ok: true };
        },
    }));
    const snapshot = { draft: 'retry me', attachments: [], source: 'enter' as const };
    await assert.rejects(controller.send(snapshot), /500/);
    await controller.send(snapshot);
    assert.deepEqual(prompts, ['retry me', 'retry me']);
});

test('046 upload rejection identifies the individual attachment', async () => {
    const attachment = intakeAttachments([], [file('bad.bin')]).items[0]!;
    const controller = createSendController(client({
        uploadAttachment: async () => { throw new Error('unsupported type'); },
    }));
    await assert.rejects(
        controller.send({ draft: 'inspect', attachments: [attachment], source: 'button' }),
        error => error instanceof AttachmentUploadError
            && error.identity === attachment.identity
            && error.message === 'unsupported type',
    );
});

test('046 slash model supports keyboard/mouse shared action and rejects file paths', () => {
    const commands = [{ name: 'plan', desc: 'Plan work' }, { name: 'review' }];
    const match = slashMatch('/pl');
    assert.deepEqual(filterSlashCommands(commands, match).map(item => item.name), ['plan']);
    assert.equal(applySlashCommand('/pl', commands[0]!, match!), '/plan');
    assert.equal(slashMatch('/tmp/a'), null);
    assert.equal(slashMatch('/Users/jun/a'), null);
    assert.equal(moveMenuIndex(0, -1, 2), 1);
});

test('046 iframe relay ignores forged origins and wrong request ids', async () => {
    const originalWindow = globalThis.window;
    const eventTarget = new EventTarget() as EventTarget & Pick<Window, 'setTimeout' | 'clearTimeout' | 'addEventListener' | 'removeEventListener'>;
    Object.assign(eventTarget, { setTimeout, clearTimeout });
    Object.defineProperty(globalThis, 'window', { value: eventTarget, configurable: true });
    const sent: unknown[] = [];
    const target = { postMessage: (message: unknown) => sent.push(message) } as unknown as Window;
    try {
        const relay = createComposerRelay(target, 'https://allowed.example', 1_000);
        const pending = relay.request('focus');
        const requestId = (sent[0] as { requestId: string }).requestId;
        const emit = (origin: string, id: string, source: Window = target) => {
            const event = new Event('message') as MessageEvent;
            Object.assign(event, { origin, source, data: { type: 'cli-jaw:composer-response', requestId: id, ok: true, payload: 'ok' } });
            eventTarget.dispatchEvent(event);
        };
        emit('https://forged.example', requestId);
        emit('https://allowed.example', 'wrong-id');
        emit('https://allowed.example', requestId, {} as Window);
        emit('https://allowed.example', requestId);
        assert.equal(await pending, 'ok');
        relay.dispose();
    } finally {
        Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
    }
});

test('046 source contracts: provider-owned transport, IME guard, STT abort, no wildcard relay', () => {
    const root = resolve(import.meta.dirname, '..', '..');
    const composer = readFileSync(resolve(root, 'public/dashboard2/src/chat/composer/Composer.tsx'), 'utf8');
    const sender = readFileSync(resolve(root, 'public/dashboard2/src/chat/composer/send-controller.ts'), 'utf8');
    const voice = readFileSync(resolve(root, 'public/dashboard2/src/chat/composer/useVoiceRecorder.ts'), 'utf8');
    const bridge = readFileSync(resolve(root, 'public/dashboard2/src/chat/composer/composer-bridge.ts'), 'utf8');
    assert.doesNotMatch(composer + sender + voice, /\bfetch\s*\(/);
    assert.match(composer, /port:\s*number/);
    assert.match(composer, /api\.instance\(port\)/);
    assert.doesNotMatch(composer, /useAppScope/);
    assert.match(composer, /nativeEvent\.isComposing/);
    assert.match(voice, /abortRef\.current\?\.abort\(\)/);
    assert.doesNotMatch(bridge, /postMessage\([^\n]+['"]\*['"]/);
});
