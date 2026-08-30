import { readSource } from './source-normalize.js';
// Discord forwarder tests — Phase 6 Bundle A
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const forwarderSrc = readSource(join(projectRoot, 'src/discord/forwarder.ts'), 'utf8');
const botSrc = readSource(join(projectRoot, 'src/discord/bot.ts'), 'utf8');

// ─── chunkDiscordMessage ────────────────────────────

test('chunkDiscordMessage splits at 2000 char limit', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const short = 'hello world';
    assert.deepEqual(chunkDiscordMessage(short), [short]);

    const long = 'a'.repeat(2001);
    const chunks = chunkDiscordMessage(long);
    assert.ok(chunks.length > 1, 'should split long message');
    assert.ok(chunks.every(c => c.length <= 2000), 'each chunk must be ≤ 2000');
});

test('chunkDiscordMessage prefers splitting at newlines', async () => {
    const { chunkDiscordMessage } = await import('../../src/discord/forwarder.js');
    const lineA = 'a'.repeat(1500);
    const lineB = 'b'.repeat(600);
    const text = `${lineA}\n${lineB}`;
    const chunks = chunkDiscordMessage(text);
    // The newline stays with the chunk it terminates. Dropping it — which the
    // previous implementation did — silently deleted the user's own blank
    // lines and code indentation.
    assert.equal(chunks[0], `${lineA}\n`, 'first chunk should split at newline and keep it');
    assert.equal(chunks.join(''), text, 'splitting must not lose content');
});

// ─── Forwarder skip logic ──────────────────────────

test('forwarder skips origin=discord to prevent echo loop', () => {
    assert.match(forwarderSrc, /shouldSkip/,
        'forwarder should have shouldSkip callback');
});

test('the shared origin policy skips own-channel turns and keeps forwarding others', async () => {
    // Behavioural, not textual. The origin rule moved into
    // `shouldSkipForwarding` so Slack, Discord and Telegram share one policy;
    // a regex over bot.ts only ever proved where the comparison was WRITTEN.
    const { shouldSkipForwarding } = await import('../../src/messaging/forwarder-origin.js');
    assert.equal(shouldSkipForwarding({ origin: 'discord' }, 'discord'), true,
        'a discord-origin turn is answered by its own dispatch path');
    assert.equal(shouldSkipForwarding({ origin: 'web' }, 'discord'), false,
        'a web turn still forwards, which is what the forwarder is for');
    assert.equal(shouldSkipForwarding({ origin: 'heartbeat' }, 'discord'), true,
        'a heartbeat job delivers to its own destination');
});

// ─── Reply path: dcOrchestrate passes chatId ────────

test('dcOrchestrate passes chatId to submitMessage', () => {
    assert.match(botSrc, /chatId.*msg\.channelId/,
        'dcOrchestrate should pass chatId from msg.channelId');
});

test('queue handler correlates by requestId for request-level isolation', () => {
    // Two forms are correct now: bracket access, because
    // noPropertyAccessFromIndexSignature makes data["requestId"] the only way to
    // read it off a Record; and !== , because the handler guards with an early
    // return rather than nesting the body in an if.
    assert.match(botSrc, /data(\.requestId|\["requestId"\])\s*[!=]==\s*requestId/,
        'queue handler should correlate by requestId');
    assert.ok(!botSrc.includes('data.target?.targetId === msg.channelId'),
        'queue handler should NOT use data.target?.targetId (not always present)');
});

test('Discord forwarder sends text before a guarded local image attachment', async () => {
    const { createDiscordForwarder } = await import('../../src/discord/forwarder.js');
    const jawHome = process.env["CLI_JAW_HOME"];
    assert.ok(jawHome, 'tests/run.mts must provide isolated CLI_JAW_HOME');
    const uploadDir = join(jawHome, 'uploads');
    mkdirSync(uploadDir, { recursive: true });
    const imagePath = join(uploadDir, 'discord-relay.png');
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sent: unknown[] = [];
    const channel = { send: async (payload: unknown) => { sent.push(payload); } };
    const target = {
        channel: 'discord' as const,
        targetKind: 'channel' as const,
        peerKind: 'channel' as const,
        targetId: 'channel-1',
    };
    const client = { channels: { fetch: async () => channel } };
    try {
        const forward = createDiscordForwarder({
            client: client as never,
            getLastTarget: () => target,
        });
        await forward('agent_done', {
            origin: 'web',
            text: `ready\n![generated](${imagePath})`,
        });
        assert.equal(sent.length, 2);
        assert.equal(typeof sent[0], 'string');
        assert.equal((sent[1] as { files: unknown[] }).files.length, 1);
    } finally {
        rmSync(imagePath, { force: true });
    }
});

// ─── orchestrateAndCollect receives chatId ──────────

test('orchestrateAndCollect call includes chatId', () => {
    const collectCall = botSrc.match(/orchestrateAndCollect\(prompt,[\s\S]*?\)/);
    assert.ok(collectCall, 'should call orchestrateAndCollect');
    assert.match(collectCall![0], /chatId/,
        'orchestrateAndCollect call should include chatId');
});
