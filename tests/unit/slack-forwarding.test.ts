import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settings } from '../../src/core/config.ts';
import { createSlackForwarder } from '../../src/slack/forwarder.ts';

// #517 round 2: the forwarder posts text, then relays local images with a
// filename caption. Nothing executed that order or the caption before — bot
// tests mocked relaySlackImages to a no-op.

type Seen = { url: string; body: Record<string, unknown> };
function fakeFetch(log: Seen[]) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
        let body: Record<string, unknown> = {};
        const raw = init?.body;
        if (typeof raw === 'string') { try { body = JSON.parse(raw); } catch { /* multipart */ } }
        log.push({ url: String(url), body });
        const payload = /getUploadURLExternal/.test(String(url))
            ? { ok: true, upload_url: 'https://files.slack.com/up', file_id: 'F1' }
            : { ok: true, ts: '1.1' };
        return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(payload) } as unknown as Response;
    }) as unknown as typeof fetch;
}

test('SFW-001: text goes first, then each image is relayed with its filename as caption', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sfw-')));
    const img = join(dir, 'chart.png');
    writeFileSync(img, 'png');
    const log: Seen[] = [];
    const priorFetch = globalThis.fetch;
    const priorWorkingDir = settings['workingDir'];
    globalThis.fetch = fakeFetch(log);
    settings['workingDir'] = dir;
    try {
        const forward = createSlackForwarder({
            getToken: () => 'xoxb-t',
            getLastTarget: () => ({ channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C1' }),
        });
        await forward('agent_done', { text: `done\n![chart](${img})` });
        assert.match(log[0]!.url, /chat\.postMessage/, 'the answer text is posted first');
        const complete = log.find((l) => /completeUploadExternal/.test(l.url));
        assert.ok(complete, 'the image was relayed');
        assert.equal(complete!.body['initial_comment'], 'chart.png');
        assert.ok(log.indexOf(complete!) > 0, 'relay happens after the text post');
    } finally {
        globalThis.fetch = priorFetch;
        settings['workingDir'] = priorWorkingDir;
    }
});
