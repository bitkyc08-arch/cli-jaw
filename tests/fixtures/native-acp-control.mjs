import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);

// This module is also the owned child executable. Test controls/records use IPC,
// never stdout (which contains only ACP JSON-RPC frames).
export function launchControlAgent(cwd, mode = 'held') {
    const child = spawn(process.execPath, [filename, mode], {
        cwd, env: { HOME: cwd, TMPDIR: cwd }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const records = [], waiters = new Set();
    child.on('message', value => {
        records.push(value);
        for (const wake of waiters) wake();
    });
    const waitFor = predicate => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error('fixture IPC deadline')); }, 3000);
        function check() {
            const value = records.find(predicate);
            if (!value) return;
            clearTimeout(timer); waiters.delete(check); resolve(value);
        }
        waiters.add(check); check();
    });
    let serial = 0;
    const command = async (action, extra = {}) => {
        const token = ++serial;
        child.send({ action, token, ...extra });
        await waitFor(value => value.kind === 'ack' && value.token === token);
    };
    const exited = new Promise(resolve => child.once('exit', resolve));
    return { child, records, waitFor, command, exited };
}

if (process.argv[1] === filename) {
    // Backstop for a failed parent assertion/teardown; this child never survives indefinitely.
    setTimeout(() => process.exit(25), 15000).unref();
    process.once('disconnect', () => process.exit(0));
    const mode = process.argv[2], sid = 'fixture-private-sid';
    let active, index = 0, cancelPending = false;
    const report = value => process.send?.(value);
    const send = (...frames) => process.stdout.write(frames.map(frame => JSON.stringify(frame) + '\n').join(''));
    const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
    const update = value => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: value } });
    const text = value => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
    function cancelResult() {
        if (!active) return;
        send(update({ sessionUpdate: 'tool_call', toolCallId: 'old-tool', title: 'old read', status: 'in_progress' }),
            text(`_LATE_${index}`));
        const terminal = reply(active, { stopReason: mode === 'noncancelled' ? 'end_turn' : 'cancelled' });
        if (mode === 'illegal-chunk') send(terminal, text('ILLEGAL_AFTER_TERMINAL'));
        else send(terminal);
        active = undefined; cancelPending = false;
        report({ kind: 'cancel-result', index });
    }
    function finish(value) {
        if (!active) return;
        send(text(value), reply(active, { stopReason: 'end_turn' }));
        active = undefined;
    }
    process.on('message', control => {
        if (control.action === 'release-cancel') cancelResult();
        if (control.action === 'finish') finish(control.text ?? 'FINAL');
        if (control.action === 'illegal') send(text('ILLEGAL_IDLE_GAP'));
        if (control.action === 'exit') process.exit(23);
        report({ kind: 'ack', token: control.token });
    });
    for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line), { method, id } = request;
        if (method === 'initialize') send(reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'cursor_login' }] }));
        else if (method === 'authenticate') send(reply(id, {}));
        else if (method === 'session/new' || method === 'session/load') send(reply(id, { sessionId: sid, configOptions: [] }));
        else if (method === 'session/prompt') {
            if (active || cancelPending) { report({ kind: 'overlap' }); process.exit(24); }
            active = id; index++;
            const prompt = request.params.prompt[0].text;
            report({ kind: 'prompt', index, prompt, sid: request.params.sessionId, pid: process.pid });
            if (mode === 'fast' && index > 1) finish('FAST_FINAL');
            else send(text(`PARTIAL_${index}`));
        } else if (method === 'session/cancel') {
            cancelPending = true; report({ kind: 'cancel', index });
            if (mode === 'exit-on-cancel') process.exit(23);
            if (mode !== 'held' && mode !== 'missing-cancel') cancelResult();
        } else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported fixture request' } });
    }
}
