---
created: 2026-08-02
tags: [cli-jaw, codex-app, pi, opencodex, runtime-pool]
---
# Runtime Integration — codex-app / pi × opencodex

> 2026-08-02 native runtime integration 유닛(`devlog/_plan/260802_native_runtime_integration/`)의 SoT 요약. 풀 계약, 취소 의미론, 모델 발견 규칙, pi rpc 판정을 다룬다.

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

- codex/codex-app 모델 목록은 기존 라이브 배선(runtime-port.json → healthz → /v1/models)이 소유. `resolveOpenCodexCodexModelsDetailed()`가 `{models, source:'opencodex'|'static'}`를 주고 registry가 `modelSource`를 노출.
- pi 프로필 discovery: `probeOpenCodexEndpointModels(endpoint)`가 **healthz 핑거프린트 `{status:'ok', service:'opencodex'}`**를 요구한 뒤에만 `<endpoint>/models` 카탈로그를 사용. 불일치/미실행이면 기존 `pi --offline --list-models` 경로 (modelSource='pi-offline').

## pi rpc 판정 (`scripts/pi-rpc-probe.mts`, `src/agent/pi-rpc-verdict.ts`)

- 2026-08-02 실probe 판정: **multi-prompt SUPPORTED + abortEffective=true** (progrok/grok-composer-2.5-fast, pi 0.83.0). 판정 근거는 프로토콜 사실(두 번째 prompt의 id 상관 success 응답 + user echo 상관) — 모델이 두 번째 턴 답변을 reasoning 채널로만 내는 비결정성과 무관.
- 판정 결과는 `~/.cli-jaw/pi/rpc-capabilities.json`에 기록(schemaVersion/commandId/probedAt). `spawnPersistentPiRpc`는 부재/파손/schema·profile·commandId 불일치/30일 초과 시 보수적 false (cancel은 kill 경로).
- persistent 세션은 풀 어댑터로 편입 (`acquirePiRuntime`); boss는 멀티턴 재사용, employee는 기존 one-shot.
