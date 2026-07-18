import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const transcript = process.env.JWC_FAKE_TRANSCRIPT;
const exitAfter = process.env.JWC_FAKE_EXIT_AFTER;
let sessionCounter = 0;

function record(message) {
    if (transcript) appendFileSync(transcript, `${JSON.stringify(message)}\n`);
}

function reply(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function reject(id, message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message } })}\n`);
}

createInterface({ input: process.stdin }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    record(message);
    if (message.id === undefined) return;
    const method = message.method;
    if (method === 'initialize') { reply(message.id, { protocolVersion: 1 }); return; }
    if (method === 'authenticate') { reply(message.id, {}); return; }
    if (method === 'session/new') {
        if (process.env.JWC_FAKE_HANG_NEW === '1') return;
        sessionCounter += 1;
        reply(message.id, { sessionId: `fake-session-${sessionCounter}` });
        // Give the host time to consume the reply before the child goes away;
        // exiting in the same tick can race readline delivery of the response.
        if (exitAfter === method) setTimeout(() => process.exit(0), 50).unref();
        return;
    }
    if (method === 'session/set_model') {
        if (String(message.params?.modelId ?? '').includes('invalid')) {
            reject(message.id, 'invalid model');
        } else {
            reply(message.id, {});
        }
        return;
    }
    if (method === 'session/close' && process.env.JWC_FAKE_HANG_CLOSE === '1') return;
    reply(message.id, {});
});

process.on('SIGTERM', () => process.exit(0));
