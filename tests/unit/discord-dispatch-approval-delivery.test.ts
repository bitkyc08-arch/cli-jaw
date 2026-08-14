import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDiscordDm } from '../../src/discord/send-only-client.js';

test('Discord operator user id is opened as a DM before approval text is sent', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
        const isOpen = String(url).endsWith('/users/@me/channels');
        return new Response(JSON.stringify(isOpen ? { id: 'DM123' } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    assert.equal((await sendDiscordDm('token', 'USER9', 'digest payload', fetchImpl)).ok, true);
    assert.deepEqual(calls.map(call => call.url.replace('https://discord.com/api/v10', '')), ['/users/@me/channels', '/channels/DM123/messages']);
    assert.deepEqual(calls[0]?.body, { recipient_id: 'USER9' });
    assert.deepEqual(calls[1]?.body, { content: 'digest payload' });
});

test('components ride on the same DM send', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
        const isOpen = String(url).endsWith('/users/@me/channels');
        return new Response(JSON.stringify(isOpen ? { id: 'DM123' } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const extra = { components: [{ type: 1, components: [{ type: 2, style: 3, custom_id: 'appr:x', label: 'Approve' }] }] };
    assert.equal((await sendDiscordDm('token', 'USER9', 'digest payload', fetchImpl, extra)).ok, true);
    assert.deepEqual(calls[1]?.body, { content: 'digest payload', components: extra.components });
});
