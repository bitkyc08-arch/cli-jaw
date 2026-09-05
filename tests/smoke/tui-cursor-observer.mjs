// Metadata-only preload for the full server. Never import application modules here.
// Writes/callbacks/return values and provider frames pass through unchanged.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';

const destination = process.env.JAW_CURSOR_OBSERVER;
if (!destination) throw new Error('JAW_CURSOR_OBSERVER must name an owned evidence file');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
let ordinal = 0, written = 0, failed = false;
function record(value) {
    if (failed) return;
    try {
        const line = JSON.stringify({ ordinal: ++ordinal, at: Date.now(), ...value }) + '\n';
        written += Buffer.byteLength(line);
        if (written > 2 * 1024 * 1024) { failed = true; appendFileSync(destination, '{"kind":"observer-limit"}\n'); return; }
        appendFileSync(destination, line, { mode: 0o600 });
    } catch { failed = true; }
}
record({ kind: 'preload', pid: process.pid, entrypoint: process.argv[1], observer: import.meta.url,
    cwd: process.cwd(), home: process.env.CLI_JAW_HOME, tmpdir: process.env.TMPDIR,
    realHome: realpathSync(process.env.CLI_JAW_HOME),
    settingsPath: join(process.env.CLI_JAW_HOME, 'settings.json'),
    settingsHash: hash(readFileSync(join(process.env.CLI_JAW_HOME, 'settings.json'))) });
function identity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
        const output = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
            { encoding: 'utf8', timeout: 600, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C' } }).trim();
        return output ? { pid, fingerprint: hash(output), startedAt: output.slice(0, 24), commandHash: hash(output.slice(24).trim()) } : null;
    } catch { return null; }
}
function ownedTool() {
    try { return identity(Number(readFileSync(process.env.JAW_CURSOR_TOOL_PID, 'utf8').trim())); }
    catch { return null; }
}
const originalSpawn = cp.spawn;
cp.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    if (args[1]?.[0] !== 'acp') return child;
    record({ kind: 'spawn', ...identity(child.pid), pid: child.pid, commandHash: hash(args[0]) });
    child.once('exit', (code, signal) => record({ kind: 'exit', pid: child.pid, code, signal }));
    const requests = new Map();
    let attempt = 0, text = '';
    const markers = (process.env.JAW_CURSOR_MARKERS ?? '').split(',').filter(Boolean);
    function outbound(frame) {
        if (frame.method === 'session/prompt') {
            attempt++; text = '';
            const prompt = (frame.params?.prompt ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
            record({ kind: 'prompt', pid: child.pid, attempt, id: frame.id,
                nativeHash: hash(frame.params?.sessionId), promptHash: hash(prompt), promptBytes: Buffer.byteLength(prompt),
                markers: markers.filter(marker => prompt.includes(marker)),
                operational: prompt.includes('[Operational Context — cli-jaw Integration]'),
                redirectContext: prompt.includes('[Cursor redirect context - read-only]') });
        }
        if (frame.method === 'session/cancel') record({ kind: 'cancel', pid: child.pid, attempt,
            nativeHash: hash(frame.params?.sessionId), tool: ownedTool() });
        if (frame.id !== undefined && frame.method) requests.set(frame.id, { method: frame.method, attempt });
    }
    function inbound(frame) {
        const pending = requests.get(frame.id);
        if (!frame.method && pending) {
            if (pending.method === 'session/prompt') record({ kind: 'response', pid: child.pid,
                attempt: pending.attempt, id: frame.id, stopReason: frame.result?.stopReason ?? null, errorCode: frame.error?.code ?? null });
            requests.delete(frame.id);
        }
        const update = frame.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
            text += update.content.text;
            if (text.length > 262144) { record({ kind: 'observer-text-limit' }); text = text.slice(-262144); }
            record({ kind: 'text', pid: child.pid, attempt, length: text.length,
                markers: markers.filter(marker => text.includes(marker)), nativeHash: hash(frame.params?.sessionId) });
        }
        if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) record({ kind: 'tool',
            pid: child.pid, attempt, itemHash: hash(update.toolCallId), status: update.status ?? null, toolKind: update.kind ?? null });
    }
    function parser(accept, direction) {
        const decoder = new StringDecoder('utf8'); let carry = '', bytes = 0;
        return chunk => {
            if (failed) return;
            try {
                bytes += Buffer.byteLength(chunk);
                if (bytes > 8 * 1024 * 1024) { record({ kind: 'observer-byte-limit', direction }); failed = true; return; }
                carry += typeof chunk === 'string' ? chunk : decoder.write(chunk);
                if (carry.length > 2 * 1024 * 1024) { record({ kind: 'observer-frame-limit', direction }); failed = true; return; }
                let end;
                while ((end = carry.indexOf('\n')) !== -1) {
                    const line = carry.slice(0, end); carry = carry.slice(end + 1);
                    if (line.trim()) accept(JSON.parse(line));
                }
            } catch { record({ kind: 'observer-parse-error', direction }); }
        };
    }
    const observeWrite = parser(outbound, 'stdin');
    const originalWrite = child.stdin.write;
    child.stdin.write = function (...values) {
        observeWrite(values[0]);
        return Reflect.apply(originalWrite, this, values);
    };
    child.stdout.on('data', parser(inbound, 'stdout'));
    return child;
};
syncBuiltinESMExports();
