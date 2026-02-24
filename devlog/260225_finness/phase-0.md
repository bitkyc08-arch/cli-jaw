# Phase 0 (P0): 당일 안정화 구현 계획

## 목표
- Claude 이벤트 중복/누락 회귀 차단
- Telegram 포워딩 중복 등록 차단
- Telegram 요청 처리 상태를 요청 단위로 분리
- skills symlink 충돌 시 데이터 유실 방지(삭제 금지)

## 재검토 기준 (2026-02-24, 최근 15개 커밋)
- 회귀 체인: `1878eaf -> 6f28e64 -> 708b718 -> 70b46c8`
- 전역 상태 리스크: `70b46c8`, `de49c05`, `9eea353`
- 구현 안전성 기준: Context7(Node.js API) + 웹 공식 문서(Anthropic/grammY/Node)

## 외부 근거 (Context7 + Web)
- Anthropic CLI reference: `--include-partial-messages`는 `--print` + `--output-format=stream-json` 조합에서 partial event를 노출함.
  - https://code.claude.com/docs/en/cli-reference
- Node EventEmitter: `on`은 중복 등록을 허용하고(`No checks ...`), `removeListener`는 한 번에 한 인스턴스만 제거.
  - https://nodejs.org/api/events.html
  - Context7 source: https://github.com/nodejs/node/blob/main/doc/api/events.md
- grammY: `bot.start()`는 stop 전까지 resolve되지 않으며, `stop()`은 polling 중단/현재 getUpdates 취소를 명시.
  - https://grammy.dev/ref/core/bot
- grammY runner `sequentialize`: 동시성에서 race condition 가능, 충돌 키 기반 순차화 필요.
  - https://grammy.dev/ref/runner/sequentialize

## 범위
- `src/events.js`
- `src/agent.js`
- `src/telegram.js`
- `src/orchestrator.js` (옵션 전달 최소 확장)
- `lib/mcp-sync.js`
- `bin/postinstall.js`

## 구현 반영 결과 (2026-02-24)
- [완료] Claude 이벤트 dedupe + assistant fallback 복구
  - `src/events.js`: `extractToolLabels(cli, event, ctx)`로 확장
  - `src/events.js`: `makeClaudeToolKey()`, `pushToolLabel()` 추가
  - `src/events.js`: `ctx.hasClaudeStreamEvents` 기반으로 `assistant` 로그/라벨 중복 차단
  - `src/agent.js`: `ctx.seenToolKeys`, `ctx.hasClaudeStreamEvents` 상태 필드 추가
- [완료] Telegram global forwarder lifecycle 고정
  - `src/telegram.js`: `telegramForwarder` 참조 보관
  - `src/telegram.js`: `detachTelegramForwarder()`/`attachTelegramForwarder(bot)` 추가
  - `src/telegram.js`: `initTelegram()` 시작 시 detach 수행 후 재초기화
- [완료] `tgProcessing` 제거 + `origin` 메타 기반 분기
  - `src/telegram.js`: `tgProcessing` 완전 제거
  - `src/telegram.js`: `orchestrateAndCollect(prompt, meta)`로 확장, Telegram 호출 시 `{ origin: 'telegram', chatId }` 전달
  - `src/agent.js`: `broadcast('agent_done', ...)` payload에 `origin` 포함
  - `src/orchestrator.js`: `orchestrate(prompt, meta)`, `orchestrateContinue(meta)`로 확장
  - `server.js`: WS/API 엔트리에서 `origin`(`cli`/`web`) 전달
- [완료] symlink 보호 모드 상향(P1 → P0)
  - `lib/mcp-sync.js`: `ensureSymlinkForce` 제거, `ensureSymlinkSafe` + backup/skip 정책 도입
  - `bin/postinstall.js`: symlink 충돌 백업 결과를 설치 로그로 노출

## 추가 핫픽스 반영 (2026-02-25)
- [완료] Copilot Telegram 상태메시지 폭주 차단
  - `src/telegram.js`: `statusMsgCreatePromise` + 스로틀 큐(`scheduleStatusUpdate`)로 생성/수정 경쟁 상태 제거
  - `src/telegram.js`: Copilot ACP `💭` 이벤트는 Telegram 상태표시에서 제외
  - `src/telegram.js`: 중복 라인/버퍼 길이 제한 적용, 완료/에러 시 타이머 정리
  - `src/telegram.js`: `orchestrate_done` 처리 시 `origin` 일치 검증 추가(웹 요청 완료 신호 혼입 방지)
- [완료] ACP request 라우팅 오류 수정
  - `src/acp-client.js`: `id + method` 메시지를 notification보다 먼저 처리하도록 분기 순서 수정
  - `src/acp-client.js`: `request()`에서 stdin 비가용 시 즉시 실패 처리(타임아웃 대기 제거)

## 구현 검증 결과 (2026-02-24)
- 문법 검증: `node --check`로 아래 파일 통과
  - `src/events.js`, `src/agent.js`, `src/orchestrator.js`, `src/telegram.js`, `server.js`, `lib/mcp-sync.js`, `bin/postinstall.js`
- 동작 스모크 테스트(스크립트 실행):
  - `stream_event` + `assistant` 연속 입력 시 tool 라벨 1회만 기록 확인
  - `assistant`만 있는 입력에서도 fallback tool 라벨 기록 확인

## 추가 검증 결과 (2026-02-25)
- `node --check src/telegram.js src/acp-client.js` 통과
- `npm run test:telegram` 통과
- `npm test` 통과 (ACP client 테스트 포함)

## 구현 시 주의사항
- `origin`은 기본값이 `'web'`이며, heartbeat 등 기존 호출부는 meta 미전달 시 기본 동작 유지
- `extractToolLabel()`는 하위호환용으로 유지되며, 실제 메인 경로는 `extractFromEvent(..., ctx)`를 통해 `extractToolLabels(..., ctx)`를 사용

---

## 0-1. Claude 이벤트 정규화 + dedupe key

### 문제
- `stream_event`와 `assistant` 이벤트가 환경/옵션에 따라 혼재
- 현재 로직은 분기 수정이 반복되며 회귀 가능성 높음

### 상세 이유 (왜 지금 필요한가)
- 현재 코드(`src/events.js`)는 Claude에서 `stream_event`만 tool 라벨을 추출하고 `assistant`는 스킵함.
- `--include-partial-messages`가 비활성 또는 실패한 환경에서는 `assistant` 경로만 남아 tool 상태가 사라짐.
- 반대로 둘 다 처리하면 중복이 생기므로, "둘 중 하나만 채택"이 아니라 "동일 이벤트 dedupe"가 필요함.

### 설계
- 파싱 전 공통 스키마로 정규화
- `ctx.seenToolKeys` 기반 dedupe
- `stream_event`를 받는 세션에서는 `assistant` tool block 무시

### 코드 스니펫 (events.js)
```js
function makeToolDedupeKey(cli, event, label) {
    if (cli !== 'claude') return `${cli}:${event.type}:${label.icon}:${label.label}`;
    const seq = event.event?.index ?? event.message?.id ?? event.type;
    return `claude:${seq}:${label.icon}:${label.label}`;
}

function pushToolLabel(labels, label, cli, event, ctx) {
    if (!ctx?.seenToolKeys) {
        labels.push(label);
        return;
    }
    const key = makeToolDedupeKey(cli, event, label);
    if (ctx.seenToolKeys.has(key)) return;
    ctx.seenToolKeys.add(key);
    labels.push(label);
}

function extractToolLabels(cli, event, ctx) {
    const labels = [];

    if (cli === 'claude' && event.type === 'stream_event' && event.event?.type === 'content_block_start') {
        // partial stream을 실제로 받았다는 세션 플래그
        ctx.hasClaudeStreamEvents = true;
        const cb = event.event.content_block;
        if (cb?.type === 'tool_use') pushToolLabel(labels, { icon: '🔧', label: cb.name || 'tool' }, cli, event, ctx);
        if (cb?.type === 'thinking') pushToolLabel(labels, { icon: '💭', label: 'thinking...' }, cli, event, ctx);
        return labels;
    }

    if (cli === 'claude' && event.type === 'assistant' && event.message?.content) {
        // partial stream이 이미 수신됐다면 assistant block은 dedupe 관점에서 스킵
        if (ctx?.hasClaudeStreamEvents) return labels; // stream 우선
        for (const block of event.message.content) {
            if (block.type === 'tool_use') pushToolLabel(labels, { icon: '🔧', label: block.name || 'tool' }, cli, event, ctx);
            if (block.type === 'thinking') pushToolLabel(labels, { icon: '💭', label: 'thinking...' }, cli, event, ctx);
        }
        return labels;
    }

    return labels;
}
```

### 코드 스니펫 (agent.js)
```js
const ctx = {
    fullText: '',
    traceLog: [],
    toolLog: [],
    seenToolKeys: new Set(),
    hasClaudeStreamEvents: false,
    // ...
};

extractFromEvent(cli, event, ctx, agentLabel); // extractToolLabels(cli, event, ctx)로 확장
```

### 완료 기준
- Claude에서 `tool_use`, `thinking` 상태가 1회씩만 표시
- `--include-partial-messages` 비활성 환경에서도 assistant fallback 정상 동작

---

## 0-2. Telegram global forwarder lifecycle 고정

### 문제
- `initTelegram()` 재호출 시 익명 listener 중복 등록 가능

### 상세 이유 (왜 지금 필요한가)
- Node 이벤트 모델 특성상 동일 핸들러 참조로 제거하지 않으면 누적 리스너가 남음.
- 현재 구현은 익명 함수로 `addBroadcastListener`를 호출해 해제가 불가능함.
- Telegram 설정 변경 시 `initTelegram()`이 재실행될 수 있어, 포워더 중복 호출 가능성이 높음.

### 설계
- forwarder 핸들러를 모듈 전역 변수로 보관
- init 시작 시 항상 detach
- attach는 1회만 수행

### 코드 스니펫 (telegram.js)
```js
let telegramForwarder = null;

function detachTelegramForwarder() {
    if (!telegramForwarder) return;
    removeBroadcastListener(telegramForwarder);
    telegramForwarder = null;
}

function attachTelegramForwarder(bot) {
    if (telegramForwarder) return; // 이미 등록됨
    telegramForwarder = (type, data) => {
        if (type !== 'agent_done' || !data?.text || data.error) return;
        if (data.origin === 'telegram') return; // 텔레그램 기원 응답 제외
        const chatIds = Array.from(telegramActiveChatIds);
        const lastChatId = chatIds.at(-1);
        if (!lastChatId) return;

        const html = markdownToTelegramHtml(data.text);
        for (const chunk of chunkTelegramMessage(html)) {
            bot.api.sendMessage(lastChatId, `📡 ${chunk}`, { parse_mode: 'HTML' })
                .catch(() => bot.api.sendMessage(lastChatId, `📡 ${chunk.replace(/<[^>]+>/g, '')}`).catch(() => {}));
        }
    };
    addBroadcastListener(telegramForwarder);
}
```

### initTelegram 적용 포인트
```js
export function initTelegram() {
    detachTelegramForwarder();
    if (telegramBot) {
        const old = telegramBot;
        telegramBot = null;
        try { old.stop(); } catch {}
    }
    // ... bot 생성 이후
    if (settings.telegram?.forwardAll !== false) {
        attachTelegramForwarder(bot);
    }
}
```

### 완료 기준
- Telegram 설정 토글/토큰 변경 후에도 포워딩 중복 전송 없음
- listener count가 init 횟수와 무관하게 1 유지

---

## 0-3. `tgProcessing` 제거, origin 기반 필터링

### 문제
- 전역 bool은 동시 요청 시 경합 발생 가능

### 상세 이유 (왜 지금 필요한가)
- 전역 `tgProcessing`은 "현재 어떤 요청의 결과인지"를 표현하지 못함.
- 동시 요청(웹 + 텔레그램, 또는 복수 텔레그램 채팅)에서 false/true 경계가 섞이면 오전송/누락이 발생함.
- `origin` 메타는 이벤트 단위로 판별 가능하므로 동시성 조건에서도 안정적임.

### 설계
- 요청 단위 전역 상태 대신 `origin` 메타를 이벤트에 실어 판단
- `agent_done`에 `origin` 포함
- Telegram forwarder는 `origin === 'telegram'`만 제외

### 코드 스니펫 (orchestrator.js)
```js
export async function orchestrate(prompt, meta = {}) {
    // ...
    if (employees.length > 0 && !needsOrchestration(prompt)) {
        // source-aware 실행: 후속 broadcast에서 origin 추적 가능
        const { promise } = spawnAgent(prompt, { origin: meta.origin || 'web' });
        const result = await promise;
        // ...
    }
    // 다른 spawnAgent 호출부도 동일하게 origin 전달
}
```

### 코드 스니펫 (telegram.js)
```js
const run = isContinueIntent(prompt)
    ? orchestrateContinue({ origin: 'telegram', chatId: ctx.chat.id })
    : orchestrate(prompt, { origin: 'telegram', chatId: ctx.chat.id });
```

### 코드 스니펫 (agent.js)
```js
const origin = opts.origin || 'web';

broadcast('agent_done', {
    text: finalContent,
    toolLog: ctx.toolLog,
    origin,
});
```

### 완료 기준
- 동시 다중 채팅에서도 Telegram 자체 요청 응답은 global forward 대상에서 정확히 제외
- 웹/CLI 요청 결과는 Telegram으로 정상 포워딩

---

## 0-4. symlink 보호 모드(P0 상향)

### 문제
- 기존 `ensureSymlinkForce()`는 실디렉토리 충돌 시 `rmSync(..., { recursive: true })`로 삭제해 데이터 유실 위험이 있었음

### 설계
- 충돌 경로를 기본 `backup` 정책으로 이동 후 symlink 재생성
- 선택적으로 `skip` 정책을 허용
- 백업 위치: `~/.cli-claw/backups/skills-conflicts/<timestamp>/...`

### 코드 스니펫
```js
// lib/mcp-sync.js
export function ensureSkillsSymlinks(workingDir, opts = {}) {
  const onConflict = opts.onConflict === 'skip' ? 'skip' : 'backup';
  // ...
  links.push(ensureSymlinkSafe(skillsSource, wdClaudeSkills, { onConflict, backupContext }));
}

function ensureSymlinkSafe(target, linkPath, opts = {}) {
  const stat = fs.lstatSync(linkPath);
  // 올바른 symlink면 noop
  // 충돌 경로면 backup 이동 후 symlink 재생성
}
```

### 완료 기준
- 충돌 경로 삭제 없이 백업됨
- postinstall 로그에서 백업 경로 추적 가능

---

## 검증 시나리오

### 수동 테스트
```bash
# 1) 서버 실행
npm run dev

# 2) 같은 프롬프트를 Web + Telegram에서 동시 전송
# 기대: Telegram 기원 응답은 중복 포워딩 없음

# 3) /api/settings 로 telegram enabled 토글 3회
# 기대: 이후 응답 포워딩이 1회만 발생
```

### 로그 체크 포인트
- `[tg:forward]` 동일 응답 2회 출력 금지
- Claude tool/thinking 상태 동일 라벨 연속 중복 금지

---

## 권장 커밋 단위
1. `[stability] events: normalize + dedupe key for claude stream/assistant`
2. `[stability] telegram: forwarder lifecycle attach/detach`
3. `[stability] telegram: remove tgProcessing, switch to origin metadata`
