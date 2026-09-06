#!/usr/bin/env node
import readline from 'node:readline';

if (process.argv.includes('--version')) {
    console.log('0.80.4');
    console.error('fixture version warning');
    process.exit(0);
}
const deadline = setTimeout(() => process.exit(97), 4000);
const send = row => process.stdout.write(JSON.stringify(row) + '\n');
const message = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });
let abortId;
for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.type === 'prompt') {
        const name = request.message;
        send({ type: 'agent_start' });
        send({ type: 'response', command: 'get_state', id: -1, success: true, data: { sessionId: 'fixture-session' } });
        send({ type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'tool fixture' }] } });
        send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking fixture' } });
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: name } });
        if (name === 'HOLD') { send({ type: 'fixture_ready' }); continue; }
        if (name === 'EOF') { process.exitCode = 0; break; }
        if (name === 'EOF_BEFORE_SETTLED') {
            send({ type: 'agent_end', messages: [message(name)] });
            process.exitCode = 0; break;
        }
        if (name === 'OWN_REJECTION') {
            send({ type: 'response', command: 'prompt', id: request.id, success: false, error: 'owned rejection' });
            continue;
        }
        if (name === 'FOREIGN_REJECTION') send({ type: 'response', command: 'prompt', id: -999, success: false, error: 'foreign rejection' });
        send({ type: 'agent_end', sessionId: 'fixture-session', messages: [message(name)] });
        send({ type: 'agent_settled' });
        if (name === 'LATE') {
            send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'MUST_NOT_APPEAR' } });
            send({ type: 'agent_end', messages: [message('MUST_NOT_APPEAR')] });
            process.exitCode = 0; break;
        }
    } else if (request.type === 'abort') {
        abortId = request.id;
        send({ type: 'response', command: 'get_state', id: -998, success: true, data: { running: false } });
        send({ type: 'response', command: 'abort', id: -997, success: true, data: { running: false } });
        send({ type: 'fixture_foreign_abort' });
    } else if (request.type === 'test_terminal') {
        send({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }] });
        send({ type: 'agent_settled' });
    } else if (request.type === 'test_ack') {
        send({ type: 'response', command: 'abort', id: abortId, success: true, data: { running: false } });
    }
}
clearTimeout(deadline);
process.stdin.destroy();
