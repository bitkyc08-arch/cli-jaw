# Phase 3: agent.js 통합

> 예상 시간: 1시간
> 핵심: 기존 `spawn(cli, args)` 패턴에 copilot ACP 분기 추가

---

## 3.1 실행 분기 — copilot만 ACP 모드

현재 agent.js의 모든 CLI는 동일한 패턴:
1. `buildArgs()` → args 배열
2. `spawn(cli, args)` → child process
3. stdout에서 ndjson/텍스트 파싱
4. stdin에 프롬프트 쓰기

**copilot은 다름**: ACP 프로토콜로 초기화 → 세션 생성 → 프롬프트 전송

### 변경: `orchestrateAgent()` 내부 (L204 부근)

```js
import { AcpClient } from './acp-client.js';

// === copilot ACP 분기 (orchestrateAgent 내부) ===

let child;

if (cli === 'copilot') {
    // ── ACP 모드 ──
    const acp = new AcpClient({
        model,
        workDir: settings.workingDir,
        permissions,
    });

    child = acp.proc; // activeProcess 용
    if (!forceNew) activeProcess = child;
    broadcast('agent_status', { running: true, agentId: agentLabel, cli });

    if (!forceNew && !opts.internal && !opts._skipInsert) {
        insertMessage.run('user', prompt, cli, model);
    }

    // session/update → broadcast 변환
    let fullText = '';
    acp.on('session/update', (params) => {
        const parsed = extractFromAcpUpdate(params);
        if (!parsed) return;
        if (parsed.tool) broadcast('agent_tool', parsed.tool);
        if (parsed.text) {
            fullText += parsed.text;
            broadcast('agent_chunk', { text: parsed.text });
        }
        if (parsed.done) {
            broadcast('agent_done', { text: fullText });
            if (!forceNew && !opts.internal && !opts._skipInsert) {
                insertMessage.run('assistant', fullText, cli, model);
            }
        }
    });

    acp.on('exit', (code) => {
        if (!fullText) {
            broadcast('agent_done', { text: '', error: `copilot exited with code ${code}` });
        }
        broadcast('agent_status', { running: false });
        if (!forceNew) activeProcess = null;
    });

    // 초기화 + 프롬프트 전송
    try {
        await acp.initialize();
        const session = await acp.createSession(settings.workingDir);

        // session_id 저장 (db)
        if (!forceNew) {
            // 기존 세션 저장 로직에 session.id 추가
        }

        await acp.prompt(
            historyBlock ? `${historyBlock}\n\n[User Message]\n${prompt}` : prompt
        );
    } catch (e) {
        broadcast('agent_done', { text: '', error: e.message });
        acp.kill();
    }

} else {
    // ── 기존 CLI 플로우 (그대로 유지) ──
    args = isResume
        ? buildResumeArgs(cli, model, effort, session.session_id, prompt, permissions)
        : buildArgs(cli, model, effort, promptForArgs, sysPrompt, permissions);
    // ... 기존 spawn 로직
}
```

---

## 3.2 `buildArgs()` — copilot case 추가

ACP 모드는 AcpClient가 내부적으로 args를 구성하므로, `buildArgs`는 fallback (비-ACP) 용으로만:

```js
case 'copilot':
    return ['-p', prompt || '', '-s',
        '--allow-all-tools',
        ...(model && model !== 'default' ? ['--model', model] : []),
        '--stream', 'on'];
```

---

## 3.3 `buildResumeArgs()` — copilot resume

```js
case 'copilot':
    return ['--acp',
        '--resume', sessionId,
        ...(model && model !== 'default' ? ['--model', model] : []),
        '--allow-all-tools'];
```

> ⚠️ `--acp --resume` 동작 여부는 Phase 2 테스트에서 확인

---

## 3.4 stdin 쓰기 분기 (L259-268)

copilot ACP에서는 stdin을 직접 쓰지 않음 (session/prompt 사용):

```diff
 if (cli === 'claude') {
     child.stdin.write(withHistoryPrompt(prompt, historyBlock));
 } else if (cli === 'codex' && !isResume) {
     const codexStdin = historyBlock
         ? `${historyBlock}\n\n[User Message]\n${prompt}`
         : `[User Message]\n${prompt}`;
     child.stdin.write(codexStdin);
-}
-child.stdin.end();
+} else if (cli !== 'copilot') {
+    // copilot은 ACP session/prompt로 전송하므로 stdin 불필요
+}
+if (cli !== 'copilot') child.stdin.end();
```

---

## Phase 3 테스트

```bash
# cli-claw 서버 시작
cd ~/Documents/BlogProject/cli-claw && node server.js

# 웹 UI에서 테스트
# 1. /cli copilot → copilot으로 전환
# 2. "hello" 입력 → 응답 확인
# 3. 중간 이벤트 (tool use) 표시 확인
# 4. 텔레그램 포워딩 동작 확인

# API 테스트
curl -X POST http://localhost:4280/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "say hello", "cli": "copilot", "model": "gpt-4.1"}'
```

### 확인 사항
- [ ] copilot spawn 성공 (프로세스 생성)
- [ ] ACP initialize + createSession 성공
- [ ] session/prompt 응답 수신
- [ ] session/update → agent_tool / agent_chunk broadcast
- [ ] agent_done 정상 발생
- [ ] activeProcess 정리 (프로세스 종료 후 null)
