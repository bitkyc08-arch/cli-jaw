import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { UPLOADS_DIR } from '../../src/core/config.ts';
import {
    SLACK_INBOUND_MESSAGE_LIMIT,
    downloadAndSaveSlackFiles,
    reserveSlackInboundBudget,
    settleSlackInboundReservation,
    type SlackInboundBudget,
} from '../../src/slack/inbound-file.ts';

const PUBLIC_DNS = async () => [{ address: '13.107.42.14', family: 4 }];
mkdirSync(UPLOADS_DIR, { recursive: true });

type FileInfo = { id: string; size: number; url: string; name?: string; mode?: string };

function fetchHarness(infos: FileInfo[], bodies: Map<string, BodyInit>, calls: Array<{ url: string; auth: string }>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, auth: new Headers(init?.headers).get('authorization') || '' });
        if (url.endsWith('/api/files.info')) {
            const id = new URLSearchParams(String(init?.body || '')).get('file');
            const file = infos.find(item => item.id === id);
            return new Response(JSON.stringify(file ? {
                ok: true,
                file: {
                    id: file.id, name: file.name || `${file.id}.bin`, size: file.size,
                    mode: file.mode || 'hosted', url_private_download: file.url,
                },
            } : { ok: false, error: 'file_not_found' }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }
        const body = bodies.get(url);
        if (body === undefined) throw new Error('unexpected download');
        return new Response(body, { status: 200 });
    }) as typeof fetch;
}

test('files.info uses bearer/form and authenticated downloads save in original order', async () => {
    const infos = [
        { id: 'F1', size: 3, url: 'https://files.slack.com/F1', name: 'one.txt' },
        { id: 'F2', size: 3, url: 'https://cdn.slack-edge.com/F2', name: 'two.txt' },
    ];
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchImpl = fetchHarness(infos, new Map([
        [infos[0]!.url, 'one'], [infos[1]!.url, 'two'],
    ]), calls);
    const result = await downloadAndSaveSlackFiles('xoxb-secret', infos.map(file => ({
        id: file.id, name: file.name, size: file.size,
    })), { fetchImpl, resolveHost: PUBLIC_DNS });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.saved.map(file => file.name), ['one.txt', 'two.txt']);
    assert.ok(result.saved.every(file => file.filePath && file.size === 3));
    assert.ok(calls.every(call => call.auth === 'Bearer xoxb-secret'));
});

test('event, files.info, Content-Length, and live-stream file caps fail closed', async () => {
    const tooLarge = 50 * 1024 * 1024 + 1;
    const eventFail = await downloadAndSaveSlackFiles('x', [{ id: 'E', name: 'e', size: tooLarge }], {
        fetchImpl: fetchHarness([], new Map(), []), resolveHost: PUBLIC_DNS,
    });
    assert.equal(eventFail.failed[0]?.code, 'size_exceeded');

    const infoCalls: Array<{ url: string; auth: string }> = [];
    const infoFail = await downloadAndSaveSlackFiles('x', [{ id: 'I', name: 'i', size: 1 }], {
        fetchImpl: fetchHarness([{ id: 'I', size: tooLarge, url: 'https://files.slack.com/I' }], new Map(), infoCalls),
        resolveHost: PUBLIC_DNS,
    });
    assert.equal(infoFail.failed[0]?.code, 'size_exceeded');

    const lengthFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/api/files.info')) return new Response(JSON.stringify({
            ok: true, file: { id: 'L', name: 'l', size: 1, url_private_download: 'https://files.slack.com/L' },
        }));
        return new Response('x', { headers: { 'content-length': String(tooLarge) } });
    }) as typeof fetch;
    const lengthFail = await downloadAndSaveSlackFiles('x', [{ id: 'L', size: 1 }], { fetchImpl: lengthFetch, resolveHost: PUBLIC_DNS });
    assert.equal(lengthFail.failed[0]?.code, 'size_exceeded');

    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (emitted++ > 50) return controller.close();
            controller.enqueue(new Uint8Array(1024 * 1024));
        },
    });
    const streamFail = await downloadAndSaveSlackFiles('x', [{ id: 'S', size: 1024 * 1024 }], {
        fetchImpl: fetchHarness([{ id: 'S', size: 1024 * 1024, url: 'https://files.slack.com/S' }], new Map([
            ['https://files.slack.com/S', stream],
        ]), []),
        resolveHost: PUBLIC_DNS,
    });
    assert.equal(streamFail.failed[0]?.code, 'size_exceeded');
    assert.equal(streamFail.saved.length, 0);
});

test('SSRF and credential-bearing URL matrix makes no download request', async () => {
    const urls = [
        'https://127.0.0.1/a', 'https://10.0.0.1/a', 'https://169.254.1.1/a',
        'https://[fc00::1]/a', 'https://user:pass@files.slack.com/a',
        'http://files.slack.com/a', 'https://evil-slack.com/a', 'https://slack.com.evil.tld/a',
    ];
    for (const [index, url] of urls.entries()) {
        const calls: Array<{ url: string; auth: string }> = [];
        const id = `F${index}`;
        const result = await downloadAndSaveSlackFiles('secret', [{ id, size: 1 }], {
            fetchImpl: fetchHarness([{ id, size: 1, url }], new Map(), calls), resolveHost: PUBLIC_DNS,
        });
        assert.equal(result.failed[0]?.code, 'private_network', url);
        assert.equal(calls.filter(call => !call.url.endsWith('/api/files.info')).length, 0, url);
    }
    const calls: Array<{ url: string; auth: string }> = [];
    const rebound = await downloadAndSaveSlackFiles('secret', [{ id: 'R', size: 1 }], {
        fetchImpl: fetchHarness([{ id: 'R', size: 1, url: 'https://files.slack.com/R' }], new Map(), calls),
        resolveHost: async () => [{ address: '192.168.1.2', family: 4 }],
    });
    assert.equal(rebound.failed[0]?.code, 'private_network');
    assert.equal(calls.filter(call => !call.url.endsWith('/api/files.info')).length, 0);
});

test('external files without a Slack-hosted URL and missing files:read use fixed codes', async () => {
    const externalFetch = (async () => new Response(JSON.stringify({
        ok: true, file: { id: 'X', name: 'x', size: 1, mode: 'external' },
    }))) as typeof fetch;
    const external = await downloadAndSaveSlackFiles('x', [{ id: 'X', size: 1, mode: 'external' }], { fetchImpl: externalFetch });
    assert.equal(external.failed[0]?.code, 'external_file_unsupported');
    const externalUrlFetch = (async () => new Response(JSON.stringify({
        ok: true,
        file: { id: 'X2', name: 'x2', size: 1, mode: 'external', url_private: 'https://drive.example/x2' },
    }))) as typeof fetch;
    const externalUrl = await downloadAndSaveSlackFiles('x', [{ id: 'X2', size: 1, mode: 'external' }], { fetchImpl: externalUrlFetch });
    assert.equal(externalUrl.failed[0]?.code, 'external_file_unsupported');

    const missingFetch = (async () => new Response(JSON.stringify({ ok: false, error: 'missing_scope', needed: 'files:read' }))) as typeof fetch;
    const missing = await downloadAndSaveSlackFiles('x', [{ id: 'M', size: 1 }], { fetchImpl: missingFetch });
    assert.equal(missing.failed[0]?.code, 'missing_scope');
});

test('40 MiB x3 streams and saves the first two; only the third exceeds message budget', async () => {
    const size = 40 * 1024 * 1024;
    const infos = ['A', 'B', 'C'].map(id => ({ id, size, url: `https://files.slack.com/${id}` }));
    const bodies = new Map<string, BodyInit>(infos.map(file => [file.url, Buffer.alloc(size)]));
    const result = await downloadAndSaveSlackFiles('x', infos.map(file => ({ id: file.id, size })), {
        fetchImpl: fetchHarness(infos, bodies, []), resolveHost: PUBLIC_DNS,
    });
    assert.deepEqual(result.saved.map(file => file.id), ['A', 'B']);
    assert.deepEqual(result.failed, [{ id: 'C', name: 'C.bin', code: 'message_budget_exceeded' }]);
    assert.ok(result.saved.every(file => file.size === size));
});

test('reservation settlement restores failed/borrowed capacity and duplicate settle is a no-op', () => {
    const budget: SlackInboundBudget = { unreservedCapacity: SLACK_INBOUND_MESSAGE_LIMIT };
    const reservation = reserveSlackInboundBudget(budget, 40)!;
    reservation.reservedConsumed = 20;
    reservation.borrowed = 5;
    budget.unreservedCapacity -= 5;
    settleSlackInboundReservation(budget, reservation, false);
    assert.equal(budget.unreservedCapacity, SLACK_INBOUND_MESSAGE_LIMIT);
    settleSlackInboundReservation(budget, reservation, false);
    assert.equal(budget.unreservedCapacity, SLACK_INBOUND_MESSAGE_LIMIT);
});

test('abort during files.info returns ingress_cancelled without saving', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as typeof fetch;
    const pending = downloadAndSaveSlackFiles('x', [{ id: 'A', size: 1 }], { fetchImpl, signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.equal(result.saved.length, 0);
    assert.equal(result.failed[0]?.code, 'ingress_cancelled');
});
