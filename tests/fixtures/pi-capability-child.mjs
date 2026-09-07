#!/usr/bin/env node
// Private finite Pi protocol fixture. Never imports Pi or contacts a provider.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const root = process.env.PI_CAPABILITY_FIXTURE_DIR;
if (!root || !path.isAbsolute(root)) throw new Error('owned fixture directory required');
const config = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const role = process.env.PI_CAPABILITY_AVAILABILITY === 'owned-path-probe'
    || config.npmFallback && path.basename(process.argv[1]) === 'pi' ? 'availability'
    : process.argv.includes('--pipe-holder') ? 'holder' : process.argv.includes('--version') ? 'version' : 'rpc';
const record = (kind, extra = {}) => fs.appendFileSync(path.join(root, 'events.ndjson'),
    JSON.stringify({ role, kind, pid: process.pid, ...extra }) + '\n');
const send = row => process.stdout.write(JSON.stringify(row) + '\n');
record('start', { args: process.argv.slice(2), cwd: process.cwd(), executable: fs.realpathSync(process.argv[1]),
    profile: process.env.PI_CODING_AGENT_DIR ?? null, sentinel: process.env.PI_CAPABILITY_SENTINEL ?? null,
    pathValue: process.env.PATH ?? null });

if (role === 'availability') {
    if (config.pathSelection) process.stdout.write((config.version ?? '0.83.0') + '\n');
    process.exit(config.pathSelection ? 0 : 1); // Fake npm fallback keeps its unavailable control.
} else if (role === 'holder') {
    // This is spawned by the test parent, which retains its real ChildProcess.
    // stdout is the duplicated version/RPC write end, not a synthetic stream.
    const deadline = setTimeout(() => { record('self-deadline'); process.exit(89); }, 10000);
    process.on('message', message => {
        if (message?.release) { clearTimeout(deadline); record('released'); process.exit(0); }
    });
    process.send?.({ holderReady: true });
} else if (role === 'version') {
    if (config.ignoreTerm) process.on('SIGTERM', () => record('term-ignored'));
    record('ready');
    const finish = async () => {
        record('released');
        const write = (stream, text) => new Promise(resolve => stream.write(text, resolve));
        await write(process.stdout, (config.version ?? '0.83.0') + '\n');
        if (config.warning) await write(process.stderr, config.warning + '\n');
        if (config.versionMode === 'overflow-stdout') await write(process.stdout, 'x'.repeat(65537));
        if (config.versionMode === 'overflow-stderr') await write(process.stderr, 'x'.repeat(65537));
        if (config.versionMode === 'pipe-held') {
            if (!process.send) throw new Error('pipe-held fixture needs private parent IPC');
            process.on('message', message => {
                if (message?.holderReady) { record('printed-exiting'); process.exit(config.versionStatus ?? 0); }
            });
            process.send({ holdPipe: true }, process.stdout, { keepOpen: true });
            return;
        }
        process.exit(config.versionStatus ?? 0);
    };
    const deadlineMs = config.longDeadline ? 20000 : 2000;
    const deadline = setTimeout(() => { record('self-deadline'); process.exit(87); }, deadlineMs);
    if (['immediate', 'overflow-stdout', 'overflow-stderr', 'pipe-held'].includes(config.versionMode)) finish();
    else if (config.versionMode !== 'never') {
        const poll = setInterval(() => {
            if (fs.existsSync(path.join(root, 'release-version'))) {
                clearInterval(poll); clearTimeout(deadline); finish();
            }
        }, 5);
    }
} else {
    const deadline = setTimeout(() => { record('self-deadline'); process.exit(88); }, 10000);
    if (config.ignoreTerm) process.on('SIGTERM', () => record('term-ignored'));
    record('ready');
    const assistant = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });
    for (const row of config.unsolicited ?? []) send(row);
    if (config.unsolicited?.length) record('unsolicited-sent');
    for await (const line of readline.createInterface({ input: process.stdin })) {
        const request = JSON.parse(line); record('request', { request });
        if (request.type === 'get_state') send({ type: 'response', command: 'get_state', id: request.id,
            success: true, data: { sessionId: 'capability-fixture-session', running: false } });
        if (request.type === 'prompt') {
            send({ type: 'response', command: 'prompt', id: request.id, success: true });
            for (const row of config.rows ?? [
                { type: 'agent_end', messages: [assistant('FINAL_ONLY')], willRetry: false },
                { type: 'agent_settled' },
            ]) send(row);
        }
        if (request.type === 'test_rows') for (const row of request.rows) send(row);
        if (request.type === 'test_exit') {
            if (config.rpcPipeHeld) {
                if (!process.send) throw new Error('RPC pipe hold needs private parent IPC');
                process.on('message', message => { if (message?.holderReady) process.exit(0); });
                process.send({ holdPipe: true }, process.stdout, { keepOpen: true });
            } else process.exit(0);
        }
        if (request.type === 'abort') {
            send({ type: 'response', command: 'abort', id: request.id, success: true, data: { running: false } });
            send({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }], willRetry: false });
            send({ type: 'agent_settled' });
        }
    }
    record('stdin-closed');
    if (config.rpcPipeOnEof) {
        if (!process.send) throw new Error('EOF pipe hold needs private parent IPC');
        process.on('message', message => { if (message?.holderReady) process.exit(0); });
        process.send({ holdPipe: true }, process.stdout, { keepOpen: true });
        await new Promise(() => {});
    }
    if (config.ignoreEof) await new Promise(() => {});
    clearTimeout(deadline);
}
