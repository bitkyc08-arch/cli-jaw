import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';

const transcript = process.env.JWC_FAKE_TRANSCRIPT;
const exitAfter = process.env.JWC_FAKE_EXIT_AFTER;
const controlPath = process.env.JWC_FAKE_CONTROL;
let sessionCounter = 0;

// One-shot dynamic hang trigger (WP8): when the control file exists with
// 'hang-new', the NEXT session/new hangs unanswered and the file is consumed,
// so a single long-lived fake can serve both success and timeout legs.
function consumeHangNew() {
    if (!controlPath || !existsSync(controlPath)) return false;
    try {
        const content = readFileSync(controlPath, 'utf8').trim();
        if (content !== 'hang-new') return false;
        rmSync(controlPath, { force: true });
        return true;
    } catch {
        return false;
    }
}

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
        if (consumeHangNew()) return;
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
