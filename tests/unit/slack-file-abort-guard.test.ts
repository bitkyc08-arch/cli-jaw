import '../setup/isolated-home.ts';
// #464: an aborted file send made ONE network call before giving up —
// files.getUploadURLExternal reserves an upload slot on Slack's side, and nobody
// completes it, so every shutdown leaves a dangling file_id. It also reported the
// cancellation as a vendor failure, which is exactly what #417 forbids.
// sendSlackText has guarded this since #417; the file path never did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendSlackFile } from '../../src/slack/slack-file.ts';
import type { RemoteTarget } from '../../src/messaging/types.ts';

const target = { channel: 'slack', targetKind: 'channel', peerKind: 'channel', targetId: 'C123' } as RemoteTarget;

function countingFetch(calls: string[]) {
    return async (url: string | URL): Promise<Response> => {
        calls.push(String(url));
        return new Response(JSON.stringify({ ok: true, upload_url: 'https://x/u', file_id: 'F1' }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
}

test('SFA-001: an already-aborted file send makes zero network calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaw-slack-abort-'));
    const path = join(dir, 'note.txt');
    writeFileSync(path, 'content');
    const calls: string[] = [];
    const res = await sendSlackFile('xoxb-test', target, path, {
        fetchImpl: countingFetch(calls) as never,
        signal: AbortSignal.abort(),
    });
    assert.deepEqual(calls, [], 'no upload slot may be reserved for a send we already cancelled');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'slack_send_aborted', 'a cancellation must not be reported as a Slack rejection');
    assert.equal(res.status, 499);
});

test('SFA-002: slackApi itself refuses an aborted signal without a request', async () => {
    const { slackApi } = await import('../../src/slack/api.ts');
    const calls: string[] = [];
    const res = await slackApi('xoxb-test', 'chat.postMessage', { channel: 'C1' }, {
        fetchImpl: countingFetch(calls) as never,
        signal: AbortSignal.abort(),
    });
    assert.deepEqual(calls, [], 'the guard cannot depend on fetch throwing AbortError');
    assert.equal(res.error, 'slack_send_aborted');
    assert.equal(res.status, 499);
});
