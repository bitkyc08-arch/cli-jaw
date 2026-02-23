# 260223 — 권한 + 타임아웃 + Telegram Tool Use

## 개요

MVP 이후 3개 핵심 개선:
1. macOS 시스템 권한 자동 안내/설정
2. 에이전트 타임아웃 개선 (JSON 응답 시 리셋)
3. Telegram tool use 실시간 표시

---

## 1. macOS 시스템 권한

### 현재 상태

| CLI    | 플래그                           | 효과                          |
| ------ | -------------------------------- | ----------------------------- |
| Claude | `--dangerously-skip-permissions` | CLI 내부 권한 프롬프트 스킵 ✅ |
| Codex  | `--full-auto`                    | 자동 승인 ✅                   |
| Gemini | `-y`                             | 자동 승인 ✅                   |

> CLI 권한은 이미 풀려 있음. 문제는 **macOS 시스템 권한** (접근성, 화면 녹화 등).

### 문제

Codex/Claude가 `osascript`나 `cliclick`으로 **브라우저 종료, 앱 조작** 같은 시스템 명령을 실행하려면:
- 접근성(Accessibility) 권한 필요
- 화면 녹화(Screen Recording) 권한 필요 (스크린샷 기반 도구)
- Full Disk Access 필요 (일부 경로 읽기)

macOS는 프로그래밍적으로 이 권한을 부여할 수 없음 (보안 정책). **자동 부여는 불가**.

### 해결 방안

#### A. `postinstall` + `doctor`에 권한 안내 추가

```
postinstall.js:
  console.log('⚠️  macOS 시스템 제어를 위해 다음 권한이 필요합니다:')
  console.log('   시스템 설정 > 개인정보 보호 > 접근성 → Terminal 추가')
  console.log('   cli-claw doctor로 권한 상태를 확인하세요')
```

#### B. `doctor`에 권한 체크 추가

```javascript
// osascript로 접근성 권한 테스트
execSync('osascript -e "tell application \\"System Events\\" to return name of first process"');
// 성공 → ✅ 접근성 권한 OK
// 실패 → ❌ 접근성 권한 필요 + 안내 출력
```

#### C. `cli-claw perms` 명령어 (선택)

```
cli-claw perms          # 권한 상태 확인
cli-claw perms open     # 시스템 설정 열기
```

```javascript
exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
```

### 파일 변경

| 파일                     | 변경                             |
| ------------------------ | -------------------------------- |
| `bin/postinstall.js`     | 권한 안내 메시지 추가            |
| `bin/commands/doctor.js` | 접근성/화면녹화/디스크 권한 체크 |
| `bin/commands/perms.js`  | [NEW] 권한 관리 명령어           |
| `bin/cli-claw`           | `perms` 커맨드 등록              |

---

## 2. 타임아웃 개선

### 현재 상태

```javascript
// orchestrateAndCollect (Telegram용) — 120초 하드코딩
timeout = setTimeout(() => {
    resolve(collected || '⏰ 시간 초과 (2분)');
}, 120000);
```

문제:
- 에이전트가 tool_use 중이어도 2분 넘으면 강제 종료
- 큰 작업(파일 수정 등)에 부족

### 해결: JSON 이벤트 수신 시 타임아웃 리셋

```javascript
function orchestrateAndCollect(prompt) {
    return new Promise((resolve) => {
        let collected = '';
        let timeout;
        const IDLE_TIMEOUT = 120000;  // 이벤트 없이 2분이면 종료

        function resetTimeout() {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                removeBroadcastListener(handler);
                resolve(collected || '⏰ 시간 초과 (2분 무응답)');
            }, IDLE_TIMEOUT);
        }

        const handler = (type, data) => {
            // JSON 이벤트가 오면 타임아웃 리셋
            if (type === 'agent_chunk' || type === 'agent_tool' ||
                type === 'agent_output' || type === 'agent_status') {
                resetTimeout();
            }
            if (type === 'agent_output') collected += data.text || '';
            if (type === 'agent_done') {
                clearTimeout(timeout);
                removeBroadcastListener(handler);
                resolve(data.text || collected || '응답 없음');
            }
        };
        addBroadcastListener(handler);
        orchestrate(prompt).catch(err => {
            clearTimeout(timeout);
            removeBroadcastListener(handler);
            resolve(`❌ ${err.message}`);
        });
        resetTimeout();
    });
}
```

핵심: **2분 절대 타임아웃 → 2분 무응답 타임아웃**. tool_use 등 이벤트가 계속 오면 무한히 기다림.

### 파일 변경

| 파일        | 변경                             |
| ----------- | -------------------------------- |
| `server.js` | `orchestrateAndCollect` 리팩토링 |

---

## 3. Telegram Tool Use 표시

### 현재 상태

- `broadcast('agent_tool', ...)` 이미 동작 중
- Web UI: `agent_tool` 이벤트 표시 ✅
- CLI chat: `agent_tool` 이벤트 표시 ✅ (방금 추가)
- Telegram: ❌ 표시 없음

### 해결: tgOrchestrate에서 tool use 중간 알림

채팅에 매 tool use마다 메시지를 보내면 스팸이므로, **typing action 대신 편집 가능한 상태 메시지** 사용:

```javascript
async function tgOrchestrate(ctx, prompt, displayMsg) {
    // ... (기존 코드)

    // 옵션: 설정에서 tool_use 표시 여부
    const showTools = settings.telegram.showToolUse !== false;
    let statusMsgId = null;

    const toolHandler = showTools ? (type, data) => {
        if (type !== 'agent_tool') return;
        const line = `${data.icon} ${data.label}`;
        if (!statusMsgId) {
            ctx.reply(line, { parse_mode: 'HTML' })
                .then(m => { statusMsgId = m.message_id; });
        } else {
            ctx.api.editMessageText(ctx.chat.id, statusMsgId, line)
                .catch(() => {});  // ignore edit failures
        }
    } : null;

    if (toolHandler) addBroadcastListener(toolHandler);
    try {
        const result = await orchestrateAndCollect(prompt);
        // ... (기존 응답 코드)
    } finally {
        if (toolHandler) removeBroadcastListener(toolHandler);
        // 상태 메시지 삭제 (선택)
        if (statusMsgId) {
            ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {});
        }
    }
}
```

UX: 하나의 메시지를 계속 edit하여 현재 tool 상태를 업데이트 → 완료 후 삭제.

### 설정

```json
// ~/.cli-claw/config.json
{
    "telegram": {
        "showToolUse": true  // default: true
    }
}
```

### 파일 변경

| 파일        | 변경                                |
| ----------- | ----------------------------------- |
| `server.js` | `tgOrchestrate`에 tool handler 추가 |
| 설정        | `telegram.showToolUse` 옵션         |

---

## 체크리스트

### Phase 1: 타임아웃 (가장 빠름)
- [ ] `orchestrateAndCollect` 리팩토링 — 이벤트 수신 시 resetTimeout
- [ ] 테스트 (Telegram 장시간 작업)

### Phase 2: Telegram Tool Use
- [ ] tgOrchestrate에 agent_tool listener 추가
- [ ] editMessage 기반 실시간 상태 표시
- [ ] showToolUse 설정 옵션
- [ ] 테스트

### Phase 3: macOS 권한
- [ ] doctor에 접근성/화면녹화 체크
- [ ] postinstall 권한 안내
- [ ] (선택) perms 명령어
- [ ] 테스트

### Phase 4: GitHub 퍼블리시 → [phase_4_publish.md](phase_4_publish.md)

### Phase 5: 모듈 분리 → [phase_5_modularize.md](phase_5_modularize.md)

### Phase 6: 채널 확장 + 스킬 → [phase_6_channels.md](phase_6_channels.md)

### Phase 6.1: 스킬 시스템 구현 ✅ → [phase_6.1_skills.md](phase_6.1_skills.md)

### Phase 6.2: 스킬 확장 + Codex 선별 → [phase_6.2_expansion.md](phase_6.2_expansion.md)

### Phase 6.3: 스킬 의존성 분석 → [phase_6.3_deps.md](phase_6.3_deps.md)

### Phase 10: MCP Reset + 코드 중복 제거 → [phase_10_mcp_reset.md](phase_10_mcp_reset.md)
