# Phase 2: ACP 클라이언트 모듈

> 예상 시간: 1시간
> 핵심 산출물: `src/acp-client.js` (새 파일)

---

## 2.1 `src/acp-client.js` — 전체 코드

```js
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import readline from 'readline';

/**
 * Copilot ACP Client — JSON-RPC 2.0 over stdio
 *
 * 사용법:
 *   const acp = new AcpClient({ model, workDir, permissions });
 *   const caps = await acp.initialize();
 *   const session = await acp.createSession(workDir);
 *   acp.on('session/update', (params) => { ... });
 *   await acp.prompt(session.id, 'hello');
 *   await acp.shutdown();
 */
export class AcpClient extends EventEmitter {
    constructor({ model = 'claude-sonnet-4.6', workDir, permissions = 'auto' }) {
        super();
        this.requestId = 0;
        this.pending = new Map(); // id → { resolve, reject, method }
        this.sessionId = null;
        this.alive = false;

        const args = [
            '--acp',
            '--model', model,
            ...(permissions === 'yolo' ? ['--yolo'] :
                permissions === 'auto' ? ['--allow-all-tools'] : []),
            '--add-dir', workDir,
        ];

        this.proc = spawn('copilot', args, {
            cwd: workDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        this.alive = true;
        this.proc.on('exit', (code) => {
            this.alive = false;
            this.emit('exit', code);
        });

        // stderr → debug logging
        this.proc.stderr.on('data', (chunk) => {
            this.emit('stderr', chunk.toString());
        });

        // stdout → newline-delimited JSON parsing
        const rl = readline.createInterface({ input: this.proc.stdout });
        rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const msg = JSON.parse(line);
                this._handleMessage(msg);
            } catch (e) {
                this.emit('parse_error', { line, error: e.message });
            }
        });
    }

    // ─── Low-level JSON-RPC ─────────────────────────

    /** Send a request (expects response) */
    request(method, params = {}) {
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`ACP timeout: ${method} (id=${id})`));
            }, 60000); // 60s timeout

            this.pending.set(id, {
                resolve: (result) => { clearTimeout(timeout); resolve(result); },
                reject: (err) => { clearTimeout(timeout); reject(err); },
                method,
            });
            this._write({ jsonrpc: '2.0', id, method, params });
        });
    }

    /** Send a notification (no response) */
    notify(method, params = {}) {
        this._write({ jsonrpc: '2.0', method, params });
    }

    _write(obj) {
        if (!this.alive) return;
        this.proc.stdin.write(JSON.stringify(obj) + '\n');
    }

    _handleMessage(msg) {
        // Response to a pending request
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) {
                reject(new Error(`ACP error: ${msg.error.message || JSON.stringify(msg.error)}`));
            } else {
                resolve(msg.result);
            }
            return;
        }

        // Notification from agent (no id)
        if (msg.method) {
            this.emit(msg.method, msg.params);
            this.emit('message', msg); // 범용 리스너
            return;
        }

        // Unknown message
        this.emit('unknown', msg);
    }

    // ─── High-level API ─────────────────────────────

    /** Initialize connection and exchange capabilities */
    async initialize() {
        const result = await this.request('initialize', {
            clientInfo: { name: 'cli-claw', version: '1.0.0' },
            capabilities: {},
        });
        this.emit('initialized', result);
        return result;
    }

    /** Create a new session with working directory */
    async createSession(workDir) {
        const result = await this.request('session/new', {
            workingDirectory: workDir,
        });
        this.sessionId = result?.sessionId;
        return result;
    }

    /** Send a prompt to the agent */
    async prompt(text, sessionId = null) {
        const sid = sessionId || this.sessionId;
        if (!sid) throw new Error('No session. Call createSession first.');
        return this.request('session/prompt', {
            sessionId: sid,
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        });
    }

    /** Resume a previous session */
    async loadSession(sessionId) {
        const result = await this.request('session/load', { sessionId });
        this.sessionId = sessionId;
        return result;
    }

    /** Cancel current operation */
    cancel(sessionId = null) {
        const sid = sessionId || this.sessionId;
        if (sid) this.notify('session/cancel', { sessionId: sid });
    }

    /** Graceful shutdown */
    async shutdown() {
        if (!this.alive) return;
        try { await this.request('shutdown', {}); } catch { }
        this.proc.kill('SIGTERM');
        this.alive = false;
    }

    /** Kill immediately */
    kill() {
        if (this.proc) this.proc.kill('SIGKILL');
        this.alive = false;
    }
}
```

---

## 2.2 ACP 메시지 캡처 테스트

Phase 2의 핵심 — **실제 ACP 메시지 형식을 캡처하여 events.js 파서 설계에 반영**.

### 테스트 스크립트: `devlog/260225_copilot-cli-integration/test-acp.js`

```js
import { AcpClient } from '../../src/acp-client.js';

const acp = new AcpClient({
    model: 'gpt-4.1', // 무료
    workDir: process.cwd(),
    permissions: 'auto',
});

// 모든 이벤트 캡처
acp.on('message', (msg) => {
    console.log('[MSG]', JSON.stringify(msg));
});
acp.on('session/update', (params) => {
    console.log('[UPDATE]', JSON.stringify(params, null, 2));
});
acp.on('stderr', (text) => {
    console.error('[STDERR]', text.trim());
});
acp.on('exit', (code) => {
    console.log('[EXIT]', code);
});
acp.on('parse_error', ({ line }) => {
    console.error('[PARSE_ERR]', line);
});

async function main() {
    console.log('[1] initialize...');
    const caps = await acp.initialize();
    console.log('[CAPS]', JSON.stringify(caps, null, 2));

    console.log('[2] createSession...');
    const session = await acp.createSession(process.cwd());
    console.log('[SESSION]', JSON.stringify(session, null, 2));

    console.log('[3] prompt: "create a file called hello.txt with Hello World"...');
    const result = await acp.prompt('create a file called hello.txt with the text Hello World');
    console.log('[RESULT]', JSON.stringify(result, null, 2));

    console.log('[4] shutdown...');
    await acp.shutdown();
}

main().catch(e => { console.error(e); process.exit(1); });
```

### 실행

```bash
cd ~/Documents/BlogProject/cli-claw
node devlog/260225_copilot-cli-integration/test-acp.js
```

### 확인 사항

- [ ] `initialize` 응답의 capabilities 구조
- [ ] `session/new` 응답의 sessionId 필드명
- [ ] `session/update` 이벤트의 `params.update.sessionUpdate` 구조
- [ ] `loadSession` capability 지원 여부 (초기화 응답에서 확인)

> 이 테스트 결과로 Phase 4 파서의 ContentChunk 구조가 최종 검증됨

---

## Phase 2 완료 기준

1. `acp-client.js` 생성 완료
2. 테스트 스크립트로 gpt-4.1 ACP 핸드셰이크 성공
3. `session/update` 이벤트 캡처 → 스키마 문서화
4. 에러 핸들링 (프로세스 죽음, 타임아웃) 동작 확인
