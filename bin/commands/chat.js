/**
 * cli-claw chat — Phase 9.5
 * Interactive REPL or --raw ndjson mode via WebSocket.
 */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        raw: { type: 'boolean', default: false },
    },
    strict: false,
});

const wsUrl = `ws://localhost:${values.port}`;

function connectWs() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.on('open', () => resolve(ws));
        ws.on('error', (err) => reject(err));
    });
}

let ws;
try {
    ws = await connectWs();
} catch {
    console.error(`  ❌ 서버에 연결할 수 없습니다 (${wsUrl})`);
    console.error('  cli-claw serve를 먼저 실행하세요.');
    process.exit(1);
}

if (values.raw) {
    // ── Raw mode: stdin lines → server, server events → ndjson stdout ──
    process.stdin.setEncoding('utf8');

    ws.on('message', (data) => {
        process.stdout.write(data.toString() + '\n');
    });

    process.stdin.on('data', (chunk) => {
        const lines = chunk.split('\n').filter(Boolean);
        for (const line of lines) {
            ws.send(JSON.stringify({ type: 'send_message', text: line }));
        }
    });

    process.stdin.on('end', () => {
        ws.close();
        process.exit(0);
    });

} else {
    // ── Interactive REPL mode ──
    console.log(`\n  🦞 cli-claw chat (port ${values.port})`);
    console.log('  Ctrl+C로 종료\n');

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '🦞 > ',
    });

    let streaming = false;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            switch (msg.type) {
                case 'agent_chunk':
                    if (!streaming) { streaming = true; process.stdout.write('\n  '); }
                    process.stdout.write(msg.text || '');
                    break;
                case 'agent_done':
                    if (streaming) { process.stdout.write('\n\n'); streaming = false; }
                    else if (msg.text) { console.log(`\n  ${msg.text}\n`); }
                    rl.prompt();
                    break;
                case 'new_message':
                    // Show messages from other sources (telegram, web)
                    if (msg.source && msg.source !== 'cli') {
                        console.log(`\n  [${msg.source}] ${msg.content?.slice(0, 80)}`);
                    }
                    break;
                case 'agent_status':
                    if (msg.status === 'running') {
                        process.stdout.write(`  ⏳ ${msg.agentName || msg.agentId} 작업 중...`);
                    }
                    break;
            }
        } catch { }
    });

    rl.on('line', (line) => {
        const text = line.trim();
        if (!text) { rl.prompt(); return; }
        if (text === '/quit' || text === '/exit') {
            ws.close();
            rl.close();
            process.exit(0);
        }
        ws.send(JSON.stringify({ type: 'send_message', text }));
    });

    rl.on('close', () => {
        ws.close();
        process.exit(0);
    });

    ws.on('close', () => {
        console.log('\n  연결 종료');
        process.exit(0);
    });

    rl.prompt();
}
