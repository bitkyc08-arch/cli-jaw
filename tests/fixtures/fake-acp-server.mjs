#!/usr/bin/env node
// A stand-in ACP agent for the recovery tests.
//
// The real jwc is not available in CI and, more importantly, cannot be told to
// hang a specific RPC on demand. This speaks just enough of the protocol to
// exercise the host's lifecycle: initialize, authenticate, session/new,
// session/prompt, session/close.
//
// Behaviour is driven by env so one file covers every case:
//   FAKE_ACP_HANG=session/close   never answer that method
//   FAKE_ACP_EXIT_AFTER=2         exit once N requests have been handled
//   FAKE_ACP_GARBAGE=1            emit a non-JSON line before answering
import { createInterface } from 'node:readline';

const hang = (process.env.FAKE_ACP_HANG ?? '').split(',').filter(Boolean);
const exitAfter = Number(process.env.FAKE_ACP_EXIT_AFTER ?? 0);
const garbage = process.env.FAKE_ACP_GARBAGE === '1';

let handled = 0;
let sessionSeq = 0;

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    if (typeof req?.id === 'undefined') return;

    if (hang.includes(req.method)) return;          // deliberately no reply
    if (garbage) process.stdout.write('this is not json\n');

    handled += 1;

    const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result });
    switch (req.method) {
        case 'initialize':
            reply({ protocolVersion: 1, agentCapabilities: {} });
            break;
        case 'authenticate':
            reply({});
            break;
        case 'session/new':
            sessionSeq += 1;
            reply({ sessionId: `fake-session-${sessionSeq}` });
            break;
        case 'session/load':
            reply({});
            break;
        case 'session/prompt':
            reply({ stopReason: 'end_turn' });
            break;
        case 'session/close':
            reply({});
            break;
        default:
            reply({});
    }

    if (exitAfter && handled >= exitAfter) {
        // Leave enough time for the reply to flush before dying.
        setTimeout(() => process.exit(7), 20);
    }
});
