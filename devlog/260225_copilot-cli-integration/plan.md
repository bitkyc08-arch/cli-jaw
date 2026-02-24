# Copilot CLI → cli-claw ACP 통합 계획 v2

> 코드리뷰 반영: 실행경로, perCli 설정, permissions, UI 하드코딩, ACP 스키마, 시스템프롬프트 전부 정리

---

## 1. 조사 결과

### 실행 환경
- `which copilot` → PATH 심링크로 해결 (`~/.local/bin/copilot` → 바이너리)
- 바이너리 원본: `~/.local/share/gh/copilot/copilot`
- **결정**: `spawn('copilot', args)` — 다른 CLI(claude, codex 등)와 동일 패턴

### ACP (Agent Client Protocol)
- `gh copilot -- --acp` → JSON-RPC 2.0 over stdio
- `gh copilot -- --acp --port 8080` → TCP
- 공식 스펙: https://agentclientprotocol.com

### ACP 메시지 플로우 (공식 스키마 기반)
```
Client                          Agent (copilot --acp)
  │                                   │
  ├─→ initialize ────────────────────→│   capabilities 교환
  │←── initialize result ────────────┤
  ├─→ session/new (workDir) ────────→│   세션 생성 (★ not session/create)
  │←── session/new result {sessionId}┤
  ├─→ session/prompt (messages) ────→│
  │←── session/update {sessionUpdate:
  │      "agent_thought_chunk"} ─────┤  💭 thinking
  │←── session/update {sessionUpdate:
  │      "tool_call"} ─────────────┤  🔧 tool
  │←── session/update {sessionUpdate:
  │      "tool_call_update"} ──────┤  ✅ result
  │←── session/update {sessionUpdate:
  │      "agent_message_chunk"} ────┤  📝 text
  │←── session/prompt result ───────┤  ✅ 완료 (stopReason)
  ├─→ session/cancel (sessionId) ───→│  취소
  ├─→ session/load (sessionId) ────→│  resume (선택적)
```

### session/update 실제 스키마 (schema.json 확인됨)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "abc-123",
    "update": {
      "sessionUpdate": "agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | plan",
      // sessionUpdate 값에 따라 추가 필드:
      // agent_message_chunk: ContentChunk {content: [{type: 'text', text: '...'}]}
      // agent_thought_chunk: ContentChunk {content: [{type: 'text', text: '...'}]}
      // tool_call: ToolCall {id, name, status, content?}
      // tool_call_update: ToolCallUpdate {id, status, content?}
      // plan: Plan {steps: [...]}
    }
  }
}
```

### 권한 / Yolo 모드
| 모드 | 플래그 | 설명 |
|------|--------|------|
| 제한 | (기본) | 매 tool call마다 확인 |
| yolo | `--yolo` | `--allow-all-tools --allow-all-paths --allow-all-urls` |
| auto | `--allow-all-tools` | 도구만 자동, 파일/URL 확인 |

→ cli-claw의 `permissions: 'auto'` → `--allow-all-tools`
→ cli-claw의 `permissions: 'yolo'` → `--yolo`

### 시스템 프롬프트 (A1, A2, B)
| 방법 | 설명 | cli-claw 연동 |
|------|------|---------------|
| `{workDir}/AGENTS.md` | 프로젝트 루트에서 자동 로딩 | ✅ B 프롬프트 그대로 사용 |
| `~/.copilot/instructions.md` | 글로벌 지시사항 | 별도 추가 가능 |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 환경변수 | 추가 디렉토리 | `.cli-claw/prompts/` 지정 가능 |
| `--no-custom-instructions` | 끄기 | 미사용 |

**결론**: cli-claw이 이미 `{workDir}/AGENTS.md`에 B 프롬프트를 쓰므로 Copilot도 자동으로 읽음. **추가 작업 불필요.**

### 모델
| 모델 | 호출명 | 비용 |
|------|--------|------|
| GPT-4.1 | `gpt-4.1` | 0x 무료 |
| GPT-5 mini | `gpt-5-mini` | 0x 무료 |
| Claude Haiku 4.5 | `claude-haiku-4.5` | 0.33x |
| GPT-5.1-Codex-Mini | `gpt-5.1-codex-mini` | 0.33x |
| Claude Sonnet 4.6 | `claude-sonnet-4.6` | 1x |
| GPT-5.3-Codex | `gpt-5.3-codex` | 1x |
| Gemini 3 Pro | `gemini-3-pro-preview` | 1x |
| Claude Opus 4.6 | `claude-opus-4.6` | 3x |

### 스킬
`~/.claude/skills/` → `~/.cli-claw/skills/` 심링크 → Copilot도 읽음. **추가 작업 불필요.**

### MCP
- Copilot: `~/.copilot/mcp-config.json`
- `syncToAll()`에 타겟 추가 필요

---

## 2. 수정해야 할 하드코딩 지점 (전체)

> 코드리뷰에서 발견: 4개 CLI가 하드코딩된 위치 전부

| 파일 | 라인 | 내용 |
|------|------|------|
| `src/config.js` | 64 | `cli: 'claude'` (기본값) |
| `src/config.js` | 68 | `perCli: { claude: {}, codex: {}, ... }` |
| `src/config.js` | 164-167 | `detectAllCli()` — 4개 CLI 감지 |
| `src/commands.js` | 10 | `DEFAULT_CLI_CHOICES = ['claude', 'codex', 'gemini', 'opencode']` |
| `src/commands.js` | 312 | `fallbackAllowed` — 4개 하드코딩 |
| `src/commands.js` | 416 | 버전 출력 — 4개 반복 |
| `src/agent.js` | 132-158 | `buildArgs()` switch-case |
| `src/agent.js` | 163-187 | `buildResumeArgs()` switch-case |
| `src/agent.js` | 247 | `spawn(cli, args)` — cli이름=커맨드명 전제 |
| `src/agent.js` | 259-268 | stdin 쓰기 — claude/codex 분기 |
| `src/events.js` | 전체 | `extractFromEvent`, `logEventSummary` — cli별 분기 |
| `public/js/features/employees.js` | 48 | UI 드롭다운 — 4개 하드코딩 |
| `public/index.html` | 86-89 | CLI 선택 `<select>` — 4개 `<option>` |
| `public/index.html` | 181-210 | CLI별 모델 옵션 — copilot 모델 추가 필요 |
| `public/js/features/settings.js` | 141-144 | `perCli` 저장 — copilot 없음 |
| `lib/mcp-sync.js` | `syncToAll()` | Claude/Codex/Gemini/OpenCode만 동기화 |

---

## 3. Phase별 구현 계획

### Phase 1: CLI 감지 + 설정 체계 + 자동 설치 (20분)

> 진행 상태(2026-02-24): ✅ 완료 (`status.md` 참조)

#### `bin/postinstall.js` — npm install 시 자동 설치
```js
// 1. Copilot 바이너리 다운로드 (없을 시, 실패해도 npm install 차단 안 함)
try {
    if (!fs.existsSync(`${home}/.local/share/gh/copilot/copilot`)) {
        execSync('gh copilot --help', { stdio: 'ignore', timeout: 30000 });
    }
} catch { console.log('[claw:init] ⚠️ Copilot CLI 미설치 (gh 미인증?)'); }
// 2. PATH 심링크: ~/.local/bin/copilot → 바이너리
const copilotBin = path.join(home, '.local', 'share', 'gh', 'copilot', 'copilot');
if (fs.existsSync(copilotBin)) {
    ensureDir(path.join(home, '.local', 'bin'));
    ensureSymlink(copilotBin, path.join(home, '.local', 'bin', 'copilot'));
}
```
- `spawn('copilot', args)` — 다른 CLI와 동일한 패턴, 특수 처리 없음

#### `src/config.js`
```diff
 perCli: {
     claude: {},
     codex: {},
     gemini: {},
     opencode: {},
+    copilot: { model: 'claude-sonnet-4.6' },
 },
```
```diff
 detectAllCli() {
     return {
         claude: detectCli('claude'),
         codex: detectCli('codex'),
         gemini: detectCli('gemini'),
         opencode: detectCli('opencode'),
+        copilot: detectCli('copilot'),  // PATH 심링크 덕분에 기존 시그니처 그대로
     };
 }
```

#### `src/commands.js`
```diff
-const DEFAULT_CLI_CHOICES = ['claude', 'codex', 'gemini', 'opencode'];
+const DEFAULT_CLI_CHOICES = ['claude', 'codex', 'gemini', 'opencode', 'copilot'];
```
- L312 `fallbackAllowed`에 copilot 추가
- L416 버전 출력 루프에 copilot 추가
- copilot 모델 목록 추가

#### `public/js/features/employees.js`
```diff
-${['claude', 'codex', 'gemini', 'opencode'].map(c => ...
+${['claude', 'codex', 'gemini', 'opencode', 'copilot'].map(c => ...
```

#### `public/index.html`
- L86-89: CLI 선택 드롭다운에 `<option value="copilot">Copilot</option>` 추가
- L181-210 아래에 copilot 모델 `<select>` 블록 추가:
  - gpt-4.1, gpt-5-mini (무료), claude-sonnet-4.6, gpt-5.3-codex 등

#### `public/js/features/settings.js`
- L141-144: `copilot: { model: getModelValue('copilot'), effort: ... }` 추가

#### `lib/mcp-sync.js`
- `syncToAll()`에 Copilot MCP 동기화 추가
- 경로: `~/.copilot/mcp-config.json`

---

### Phase 2: ACP 클라이언트 모듈 (1시간)

#### `src/acp-client.js` [NEW]

```js
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export class AcpClient extends EventEmitter {
    constructor(model, workDir, permissions) {
        super();
        this.requestId = 0;
        this.pending = new Map(); // id → {resolve, reject}

        // spawn: PATH 심링크 덕분에 다른 CLI와 동일하게 실행
        const args = [
            '--acp',
            '--model', model,
            ...(permissions === 'auto' ? ['--allow-all-tools'] : []),
            ...(permissions === 'yolo' ? ['--yolo'] : []),
            '--add-dir', workDir,
        ];
        this.proc = spawn('copilot', args, {
            cwd: workDir,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // newline-delimited JSON 파싱
        let buffer = '';
        this.proc.stdout.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 미완성 라인 보관
            for (const line of lines) {
                if (line.trim()) this._handleMessage(JSON.parse(line));
            }
        });
    }

    // JSON-RPC request (응답 대기)
    async request(method, params) {
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this._write({ jsonrpc: '2.0', id, method, params });
        });
    }

    // JSON-RPC notification (응답 없음)
    notify(method, params) {
        this._write({ jsonrpc: '2.0', method, params });
    }

    _write(obj) {
        this.proc.stdin.write(JSON.stringify(obj) + '\n');
    }

    _handleMessage(msg) {
        if (msg.id && this.pending.has(msg.id)) {
            // Response to a request
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
        } else if (msg.method) {
            // Notification from agent
            this.emit(msg.method, msg.params);
        }
    }

    // ── High-level API ──

    async initialize() {
        return this.request('initialize', {
            clientInfo: { name: 'cli-claw', version: '0.1.0' },
        });
    }

    async createSession(workDir) {
        return this.request('session/new', { workingDirectory: workDir });
    }

    async prompt(sessionId, text) {
        return this.request('session/prompt', {
            sessionId,
            messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        });
    }

    async cancel(sessionId) {
        this.notify('session/cancel', { sessionId });
    }

    async shutdown() {
        try { await this.request('shutdown', {}); } catch {}
        this.proc.kill();
    }
}
```

**검증**: 단독 스크립트로 ACP 핸드셰이크 + "say hello" 프롬프트 + 응답 수신 테스트 (gpt-4.1 무료 모델)

---

### Phase 3: agent.js 통합 (1시간)

#### 실행 경로 문제 해결
현재 `spawn(cli, args)` → `cli='copilot'` → `copilot` 존재하지 않음 ❌

**해결**: copilot일 때만 특수 처리
```js
// agent.js L247 부근
let child;
if (cli === 'copilot') {
    // ACP 모드: AcpClient가 프로세스 관리
    const acp = new AcpClient(model, settings.workingDir, permissions);
    await acp.initialize();
    const session = await acp.createSession(settings.workingDir);

    // session/update 이벤트 → broadcast
    acp.on('session/update', (params) => {
        // → events.js의 extractFromAcpUpdate로 변환
    });

    acp.prompt(prompt); // sessionId는 createSession에서 자동 저장됨
    child = acp.proc; // activeProcess용
} else {
    child = spawn(cli, args, { ... });
}
```

#### buildArgs / buildResumeArgs
- copilot case는 **불필요** — AcpClient 내부에서 args 구성
- 대신 AcpClient 생성자에 model/permissions/workDir 전달

#### stdin 쓰기
- copilot은 ACP JSON-RPC로 프롬프트 전송 → `child.stdin.write()` 불필요
- `session/prompt` 메서드가 대체

#### 이어하기 (/continue)
**결정: CLI `--resume` 방식 사용** (ACP 내부 resume 여부 Phase 2에서 확인)

방법 A — CLI 레벨:
```js
spawn('copilot', ['--acp', '--resume', sessionId, ...]);
```

방법 B — ACP 레벨 (**공식 스펙 확인됨**):
```js
acp.request('session/load', { sessionId });
```

- **`session/load`는 ACP 공식 메서드** (선택적 capability)
- Phase 2 테스트에서 copilot이 `loadSession` capability 지원하는지 확인
- sessionId는 db session 테이블의 기존 `session_id` 컬럼에 저장

---

### Phase 4: events.js 파싱 (30분)

#### `src/events.js`

ACP `session/update` → cli-claw broadcast 변환:

```js
function extractFromAcpUpdate(params) {
    const update = params?.update;
    if (!update) return null;
    const type = update.sessionUpdate; // 공식 discriminator

    switch (type) {
        case 'agent_thought_chunk':
            return { tool: { icon: '💭', label: extractText(update.content).slice(0, 60) } };
        case 'tool_call':
            return { tool: { icon: '🔧', label: update.name || 'tool' } };
        case 'tool_call_update':
            return { tool: { icon: '✅', label: update.name || 'done' } };
        case 'agent_message_chunk':
            return { text: extractText(update.content) };
        case 'plan':
            return { tool: { icon: '📝', label: 'planning...' } };
        default:
            return null;
    }
}
```

> **확정**: `update.sessionUpdate`가 discriminator (공식 schema.json)
> Phase 4 상세 구현은 `phase-4.md` 참고

#### `logEventSummary` + `extractToolLabels`
- copilot case 추가: ACP 이벤트는 별도 함수에서 처리하므로 기존 파서 변경 최소화

---

### Phase 5: 마무리 (30분)

#### `src/db.js`
- copilot sessionId 저장: 기존 `session_id` 컬럼 그대로 활용 (변경 불필요)

#### 테스트
1. `gpt-4.1` (무료)로 기본 대화 테스트
2. tool use 있는 프롬프트로 중간 이벤트 확인
3. `/continue` 이어하기 테스트
4. 텔레그램 포워딩 동작 확인
5. `/cli copilot` 전환 + `/model gpt-5.3-codex` 모델 변경

---

## 4. 파일 변경 목록 (완전판)

| 파일 | Phase | 변경 |
|------|-------|------|
| `src/config.js` | 1 | perCli에 copilot 추가, detectAllCli 추가 |
| `src/commands.js` | 1 | DEFAULT_CLI_CHOICES, fallback, 버전출력, 모델목록 |
| `bin/postinstall.js` | 1 | Copilot 자동설치 + PATH 심링크 |
| `public/index.html` | 1 | CLI 드롭다운, 모델 select, effort select 추가 |
| `public/js/features/settings.js` | 1 | perCli.copilot 저장 |
| `public/js/features/employees.js` | 1 | UI 드롭다운에 copilot 추가 |
| `lib/mcp-sync.js` | 1 | syncToAll에 `~/.copilot/mcp-config.json` 추가 |
| **`src/acp-client.js`** | **2** | **[NEW] ACP JSON-RPC 클라이언트** |
| `src/agent.js` | 3 | copilot ACP 분기: AcpClient 사용 |
| `src/events.js` | 4 | extractFromAcpUpdate 추가 |
| `src/db.js` | 5 | 변경 불필요 (기존 session_id 활용) |

## 5. 예상 소요

| Phase | 난이도 | 시간 |
|-------|--------|------|
| 1 - 설정 + 감지 + UI + 설치 | ⭐ | 20분 |
| 2 - ACP 클라이언트 | ⭐⭐⭐ | 1시간 |
| 3 - agent.js 통합 | ⭐⭐⭐ | 1시간 |
| 4 - events.js 파싱 | ⭐⭐ | 30분 |
| 5 - 테스트 + 마무리 | ⭐⭐ | 30분 |
| **합계** | | **~3시간 20분** |

## 6. 리스크 / 열린 질문

1. **ACP `session/update` 실제 스키마 미확인** → Phase 2 테스트에서 캡처 필수
2. **Copilot ACP가 아직 초기** → 스키마 breaking change 가능성
3. **MCP config 포맷** → `~/.copilot/mcp-config.json` 포맷이 Claude의 `.mcp.json`과 같은지 확인 필요
4. **`--acp --resume` 동시 사용** → Phase 2 테스트에서 확인, 안 되면 long-lived 프로세스 방식
