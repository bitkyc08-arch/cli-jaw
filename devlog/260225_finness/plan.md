# 260225 Finness Plan

## 검토 범위 (최근 10개 커밋)
- `042f04e` `[copilot] devlog: ACP integration plan v2 + phase 1-5 detailed docs`
- `1e928ae` `[agent] fix: centralize .claude/skills symlink in ensureSkillsSymlinks with force replace`
- `54dedd8` `[agent] feat: auto-setup .claude/skills symlink in postinstall + resetSkills + MCP sync`
- `32db135` `[devlog] 260224 Claude 실시간 스트리밍 + 텔레그램 동기화 상세 기록`
- `70b46c8` `[agent] feat: forward all responses to Telegram + fix duplicate tool status`
- `708b718` `[agent] fix: remove duplicate Claude tool broadcast (stream_event vs assistant)`
- `6f28e64` `[agent] feat: Claude stream_event parsing for real-time tool/thinking status + --include-partial-messages`
- `de49c05` `[agent] config: telegram idle timeout 4min → 20min`
- `1878eaf` `[agent] fix: Claude event parsing - broadcast all tool blocks + strip XML tags for telegram`
- `c16b0d8` `[agent] feat: CCS Wrapper 모델 등록 + devlog 추가`

## 커밋 로그에서 드러난 문제 패턴

### 1) 이벤트 파싱 회귀가 반복됨 (Claude stream/assistant 중복 처리)
- 근거: `1878eaf` → `6f28e64` → `708b718` 연속 수정
- 징후: `src/events.js`에서 `stream_event`/`assistant` 처리 정책이 커밋마다 변경됨
- 리스크: 중복 브로드캐스트 재발, 또는 일부 tool/thinking 이벤트 누락

### 2) Telegram 포워딩 상태 관리가 전역 플래그 중심이라 경합 위험
- 근거: `70b46c8`, `de49c05`
- 징후: `src/telegram.js`의 `tgProcessing`(전역 bool) + 전역 broadcast listener
- 리스크: 다중 채팅/동시 요청 시 잘못된 중복 차단 또는 오전송

### 3) Telegram listener 생명주기 관리 누락 가능성
- 근거: `70b46c8` 이후 `initTelegram()` 재호출 구조
- 징후: `addBroadcastListener((type, data) => { ... })` 익명 함수 등록, 해제 핸들 없음
- 리스크: 설정 변경으로 bot 재초기화될 때 포워딩 중복 등록 가능

### 4) symlink 강제 교체 로직의 안전장치 부족
- 근거: `54dedd8` → `1e928ae`
- 징후: `ensureSymlinkForce()`가 기존 실디렉토리를 바로 삭제(`fs.rmSync`)
- 리스크: 사용자 기존 `~/.claude/skills` 실제 파일 유실 가능

### 5) CLI/모델 카탈로그가 파일별로 분산되어 불일치
- 근거: `c16b0d8`, `042f04e`
- 징후:
  - `src/config.js`, `src/commands.js`, `public/index.html`, `public/js/constants.js`, `public/js/features/*`가 각각 별도 하드코딩
  - 백엔드 opencode 모델과 프론트 `MODEL_MAP` 값 불일치
- 리스크: UI 선택값과 실제 실행값 불일치, 설정 저장/복구 오류

### 6) 회귀 방지 테스트 부재
- 근거: 최근 이슈가 같은 날 연쇄 hotfix 형태로 반복
- 징후: 테스트 스크립트/`*.test.*` 없음, `package.json`에 test script 없음
- 리스크: 이벤트/텔레그램/설정 관련 버그 재발

## 수정 계획 (우선순위 재배치, 2026-02-24 반영)

### P0. 안정화 + 데이터 보호 (당일)
1. 이벤트 정규화 레이어 추가
- 대상: `src/events.js`, `src/agent.js`
- 작업: `stream_event`/`assistant`를 공통 이벤트 스키마로 변환 후 dedupe key 기반 브로드캐스트
- 완료 기준: Claude에서 tool/thinking 이벤트 중복 0건, 누락 0건

2. Telegram 포워딩 listener lifecycle 고정
- 대상: `src/telegram.js`
- 작업: 전역 포워더를 named handler로 등록/해제 가능하게 변경 (`initTelegram` 재실행 시 기존 handler 제거)
- 완료 기준: Telegram 설정 변경(ON/OFF, token 변경) 반복 후에도 포워딩 메시지 1회만 발송

3. `tgProcessing` 전역 bool 제거 또는 요청 단위 상태로 교체
- 대상: `src/telegram.js`
- 작업: `requestId`/`source` 기반으로 현재 처리 중 요청만 제외하고 나머지는 정상 포워딩
- 완료 기준: 동시 2개 채팅 요청에서 서로의 응답 누락/중복 없음

4. symlink 생성 보호 모드 도입 (P1 → P0 상향)
- 대상: `lib/mcp-sync.js`, `bin/postinstall.js`
- 작업: 실디렉토리 발견 시 `backup + 안내` 또는 `skip + 경고` 정책 적용 (무조건 삭제 금지)
- 완료 기준: 기존 사용자 스킬 디렉토리 보존, 로그에 명확한 액션 기록

### P1. 정합성 + 최소 회귀 테스트 (1~2일)
1. CLI/모델 단일 소스화
- 대상: `src/config.js`, `src/commands.js`, `public/js/constants.js`, `public/js/features/settings.js`, `public/js/features/employees.js`, `public/index.html`
- 작업: `cliRegistry`(이름/모델/effort/표시명)를 한 군데서 관리하고 프론트/백엔드 공유
- 완료 기준: 모델 목록 diff 0건, 새 CLI 추가 시 수정 파일 1~2개로 제한

2. Copilot 문서와 실제 코드 간 갭 정리
- 대상: `devlog/260225_copilot-cli-integration/*`, 실제 구현 파일
- 작업: 완료/미완료 항목 체크리스트화, 미구현은 TODO로 명시
- 완료 기준: 문서 상태와 코드 상태 불일치 항목 0건

3. 최소 회귀 테스트 2개 선반영 (P2 → P1 상향)
- 대상: `src/events.js` + 신규 `tests/events.test.js`
- 대상: 신규 `tests/telegram-forwarding.test.js` (mock bus 기반)
- 작업: 일반 응답 포워딩, tg 요청 중복 방지, 재초기화 후 listener 중복 방지 검증
- 대상: `package.json`
- 작업: `test:events`, `test:telegram` 최소 스크립트 추가
- 완료 기준: 핵심 회귀 2개가 `npm run test:events`, `npm run test:telegram`으로 즉시 재현 가능

### P2. 테스트 확장/자동화 (2~3일)
1. 이벤트 파서 fixture 확장
- 대상: `tests/events.test.js`, `tests/fixtures/*`
- 작업: Claude/Codex/Gemini/OpenCode 공통 fixture 세트 확대
- 완료 기준: 신규 CLI/이벤트 타입 추가 시 fixture 기반 회귀 검증 가능

2. Telegram 동작 시나리오 확장
- 대상: `tests/telegram-forwarding.test.js`
- 작업: 다중 init, listener detach, chunk fallback, 동시 요청 경합 케이스 추가
- 완료 기준: lifecycle/경합 회귀를 자동 테스트로 차단

3. 자동화 루프 정비
- 대상: `package.json` (+ 필요 시 CI)
- 작업: `npm test` 집계 스크립트 및 pre-push/CI 훅 연동
- 완료 기준: PR 전 1회 실행으로 핵심+확장 테스트 검증

## 바로 실행할 첫 작업 세트 (추천, 재배치 반영)
1. `tests/events.test.js` 최소 3케이스 작성 (`stream_event`, `assistant fallback`, `stream 이후 assistant 무시`)
2. `tests/telegram-forwarding.test.js` 최소 2케이스 작성 (`origin=telegram skip`, `error skip`)
3. `package.json`에 `test:events`, `test:telegram` 추가 후 수동 실행 루프 고정

---

## 2026-02-24 보정 (Phase 8 리뷰 반영)

- 아래 항목은 최신 코드 기준으로 **완료/보정 필요**:
  - 테스트 스크립트 부재 이슈: 해소 (`npm run test`, `test:events`, `test:telegram` 존재)
  - Telegram 전역 포워더 lifecycle 이슈: 해소 (`createForwarderLifecycle` 기반 detach/attach 적용)
  - symlink 강제 삭제 이슈: 보정 (`ensureSkillsSymlinks(..., { onConflict: 'backup' })`)

- 새 우선순위:
  1. **Phase 9** 진행 (백엔드 보안/검증/회귀 테스트, 프런트 제외)
  2. Phase 8의 구조 분리 작업은 Phase 9 P0/P1 완료 후 착수

- 상세 계획 문서: `devlog/260225_finness/phase-9.md`
- `dev` 스킬의 연관 스킬(`security-best-practices`, `static-analysis`, `tdd`, `debugging-checklist` 등) 검토 결과도 `phase-9.md`에 반영
