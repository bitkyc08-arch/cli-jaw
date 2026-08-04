---
created: 2026-08-02
tags: [cli-jaw, codex-app, pi, opencodex, runtime-pool]
---
# Runtime Integration — codex-app / pi × opencodex

> 2026-08-02 native runtime integration 유닛(`devlog/_fin/260802_native_runtime_integration/`)의 SoT 요약. 풀 계약, 취소 의미론, 모델 발견 규칙, pi rpc 판정을 다룬다.

## Resident Runtime Pool (`src/agent/runtime-pool.ts`)

- boss/main 실행은 메시지당 spawn 대신 상주 런타임 풀을 탄다. 키 = 엔진별 독립 스토어 + `chat:${getActiveChatSession()}` + cwd + 모델/effort/(pi는 profile/endpoint/apiKind/profileFp).
- employee는 풀링하지 않는다 (매 턴 timestamped cwd + cleanup과 모순 — per-turn spawn 유지).
- 엔트리 상태기: `creating` → `ready`(busy/dead) + 대기자 큐. 조회/마킹은 동기 임계 구역, `drainWaiters`가 splice→clearTimeout→resolve/reject 순서를 보장.
- 죽은 런타임은 다음 acquire에서 재생성: codex-app은 `thread/resume`(복구 가능 분류 `isRecoverableResumeError` — 실물 에러 "no rollout found for thread id ..."), pi는 `--session-id`.
- 취소는 lease의 단일 `cancel()`: `supportsInterrupt`면 interrupt(codex-app `turn/interrupt` {threadId, turnId}; pi는 `abort` 세션 계약), 아니면 kill+dead 마킹. codex-app latch 경로는 activeTurnId 부재 시 이벤트 대기(interrupt-failed/turn-completed/10s timeout) 후 실패 시 kill 폐번.
- idle TTL 15분 리퍼. `poolStats()`로 진단.

## codex-app exec-parity (`src/agent/codex-app-client.ts`, `codex-app-catalog.ts`)

- `thread/start`와 `thread/resume` 모두 `developerInstructions` 전송 (jaw sysPrompt가 wire에 도달 — "app-server가 멍청"의 jaw 측 주원인이었음).
- 매 `turn/start`에 effort 명시. `model/list`는 cursor 페이지네이션.
- spawn 전 model/effort 사전검증: `$CODEX_HOME/model_catalog_json`의 `supported_reasoning_levels` 기반, 카탈로그 부재/미등재는 fail-open, 등재 모델의 미지원 effort만 fail-fast (openai/codex#31552형 행 방지).
- 승인 자동응답: `item/permissions/requestApproval`에는 `{permissions:{}, scope:'turn'}`(빈 grant = 정상 거부 경로), 나머지는 decision/answers decline 맵.
- pre-turn 취소 레이스는 pending-interrupt latch로 흡수 (`setActiveTurnId` 단일 대입점 + terminal-race 분류기, 실패는 `interrupt-failed`로 표면화).

## 모델 발견 (`src/cli/opencodex-models.ts` 소유)

- codex/codex-app 모델 목록은 기존 라이브 배선(runtime-port.json → healthz → /v1/models)이 소유. `resolveOpenCodexCodexModelsDetailed()`가 `{models, entries, source:'opencodex'|'static'}`를 주고 registry가 `modelSource`를 노출.
- **모델별 reasoning effort도 같은 배선으로 동기화된다.** ocx는 모델마다 다른 effort 집합을 광고한다
  (`gpt-5.6-sol`은 `ultra`까지, `gpt-5.6-luna`는 `max`까지, `anthropic/*` 같은 routed 모델은 없음).
  `parseModelEntries()`가 `reasoning_efforts[].value` / `supports_reasoning_effort` / `reasoning_effort`를
  `{id, efforts, defaultEffort}`로 파싱하고, `registry-live.ts`가 codex/codex-app에
  `effortsByModel`·`defaultEffortByModel`을 싣는다. `efforts`는 legacy 소비자용 합집합이다.
- effort 값은 표시용이 아니라 wire 값이다(`src/agent/args.ts` codex 분기 →
  `-c model_reasoning_effort="<effort>"`). 그래서 UI 선택기는 합집합이 아니라
  **선택된 모델의 집합**을 써야 하고, 빈 배열은 "이 모델은 effort 없음"을 뜻하므로 fallback 금지다.
- **`ai-e`는 provider 스코프를 쓴다.** `ai-e`는 provider별로 모델 목록이 갈리므로
  평평한 `effortsByModel`은 id 충돌을 일으킨다: `gpt-5.6-sol`이 codex와 kiro 양쪽에
  존재하는데 Kiro는 `low/medium/high/xhigh`만 받는다(`args.ts` `KIRO_EFFORTS`).
  따라서 `ai-e`에는 `effortsByModelByProvider`/`defaultEffortByModelByProvider`를
  싣고 평평한 키는 싣지 않는다. codex/codex-app은 provider 개념이 없어 평평한 맵을 유지한다.
  해석 우선순위: provider 스코프 모델 → 평평한 모델 → provider 목록 → registry 목록.
  스코프 맵이 있어도 **모델 키가 없으면 provider 목록으로 폴백**한다(근거 없는 축소 금지).
- `/effort` 슬래시 명령과 TUI 셀렉터도 같은 소스를 쓴다. 과거에는
  `['off','low','medium','high','max']`를 하드코딩해 `xhigh`가 아예 없고 `ultra`를
  거부했다. 지금은 `resolveEffortLevelsForCli(cli, model)`이 codex 계열이면 ocx
  entries에서, 그 외에는 registry에서 목록을 만든다. 저장은 런타임이 실제로 읽는
  `perCli.<cli>.effort` + `activeOverrides.<cli>.effort`로 간다
  (top-level `settings.effort`는 저장돼도 아무도 읽지 않는 죽은 키다).
- `defaultModel`/`defaultEffort`는 라이브 값으로 교체하지 않는다. `buildDefaultPerCli()`가
  사용자 기본값을 여기서 seed하므로 ocx 라우팅 순서 변화가 사용자 설정을 조용히 바꾸면 안 된다.
- pi 프로필 discovery: `probeOpenCodexEndpointModels(endpoint)`가 **healthz 핑거프린트 `{status:'ok', service:'opencodex'}`**를 요구한 뒤에만 `<endpoint>/models` 카탈로그를 사용. 불일치/미실행이면 기존 `pi --offline --list-models` 경로 (modelSource='pi-offline').

## pi rpc 판정 (`scripts/pi-rpc-probe.mts`, `src/agent/pi-rpc-verdict.ts`)

- 2026-08-02 실probe 판정: **multi-prompt SUPPORTED + abortEffective=true** (progrok/grok-composer-2.5-fast, pi 0.83.0). 판정 근거는 프로토콜 사실(두 번째 prompt의 id 상관 success 응답 + user echo 상관) — 모델이 두 번째 턴 답변을 reasoning 채널로만 내는 비결정성과 무관.
- 판정 결과는 `~/.cli-jaw/pi/rpc-capabilities.json`에 기록(schemaVersion/commandId/probedAt). `spawnPersistentPiRpc`는 부재/파손/schema·profile·commandId 불일치/30일 초과 시 보수적 false (cancel은 kill 경로).
- persistent 세션은 풀 어댑터로 편입 (`acquirePiRuntime`); boss는 멀티턴 재사용, employee는 기존 one-shot.
