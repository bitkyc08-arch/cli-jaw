# CLI-JAW — Source Structure & Function Reference

> 마지막 검증: 2026-02-26T02:40 (multi-instance Phase 1-4.1 반영)
> server.ts 935L / src/ 36파일 13서브디렉토리 / tests 314 total · 306 pass (tsx runner)
> Phase 9 보안 하드닝 + Phase 17 AI triage + Phase 20.6 모듈 분리 + parallel dispatch + session fix + cli-jaw rename + orchestration v3 + **multi-instance refactor (Phase 1-4.1)** 반영
>
> 상세 모듈 문서는 [서브 문서](#서브-문서)를 참조하세요.

---

## File Tree

```text
cli-jaw/
├── server.ts                 ← Express 라우트 + 글루 + ok/fail + security guards (935L)
├── lib/
│   ├── mcp-sync.ts           ← MCP 통합 + 스킬 복사 + DEDUP_EXCLUDED + 글로벌 설치 (661L)
│   ├── upload.ts             ← 파일 업로드 + Telegram 다운로드 (70L)
│   └── quota-copilot.ts      ← Copilot 할당량 조회 (keychain → API) (68L)
├── src/
│   ├── core/                 ← 의존 0 인프라 계층
│   │   ├── config.ts         ← JAW_HOME, settings, CLI 탐지, APP_VERSION (215L)
│   │   ├── db.ts             ← SQLite 스키마 + prepared statements + trace (105L)
│   │   ├── bus.ts            ← WS + 내부 리스너 broadcast (20L)
│   │   ├── logger.ts         ← 로거 유틸 (11L)
│   │   ├── i18n.ts           ← 서버사이드 번역 (90L)
│   │   └── settings-merge.ts ← perCli/activeOverrides deep merge (45L)
│   ├── agent/                ← CLI 에이전트 런타임
│   │   ├── spawn.ts          ← CLI spawn + ACP 분기 + 큐 + 메모리 flush + activeOverrides 통합 (691L)
│   │   ├── args.ts           ← CLI별 인자 빌더 (67L)
│   │   └── events.ts         ← NDJSON 파서 + ACP update + logEventSummary (322L)
│   ├── orchestrator/         ← 직원 오케스트레이션
│   │   ├── pipeline.ts       ← Plan → Distribute → Quality Gate (493L, parallel/sequential + end_phase/checkpoint + reset)
│   │   ├── distribute.ts     ← runSingleAgent + buildPlanPrompt + parallel helpers (356L)
│   │   └── parser.ts         ← triage + subtask JSON + verdict 파싱 + isResetIntent (126L)
│   ├── prompt/               ← 프롬프트 조립
│   │   └── builder.ts        ← A-1/A-2 + 스킬 + 직원 프롬프트 v2 + promptCache + dev skill rules (557L)
│   ├── cli/                  ← 커맨드 시스템
│   │   ├── commands.ts       ← 슬래시 커맨드 레지스트리 + 디스패처 + 파일경로 필터 (271L)
│   │   ├── handlers.ts       ← 18개 커맨드 핸들러 (432L)
│   │   ├── registry.ts       ← 5개 CLI/모델 단일 소스 (89L)
│   │   └── acp-client.ts     ← Copilot ACP JSON-RPC 클라이언트 (328L)
│   ├── memory/               ← 데이터 영속화
│   │   ├── memory.ts         ← Persistent Memory grep 기반 (129L)
│   │   ├── worklog.ts        ← Worklog CRUD + phase matrix (172L)
│   │   └── heartbeat.ts      ← Heartbeat 잡 스케줄 + fs.watch (108L)
│   ├── telegram/             ← Telegram 인터페이스
│   │   ├── bot.ts            ← Telegram 봇 + forwarder lifecycle + origin 필터링 (497L)
│   │   └── forwarder.ts      ← 포워딩 헬퍼 (escape, chunk, createForwarder) (105L)
│   ├── browser/              ← Chrome CDP 제어
│   │   ├── connection.ts     ← Chrome 탐지/launch/CDP 연결 (113L)
│   │   ├── actions.ts        ← snapshot/click/type/navigate/screenshot (179L)
│   │   ├── vision.ts         ← vision-click 파이프라인 + Codex provider (138L)
│   │   └── index.ts          ← re-export hub (13L)
│   ├── routes/               ← Express 라우트 추출
│   │   ├── quota.ts          ← Copilot/Claude/Codex 할당량 (82L)
│   │   └── browser.ts        ← 브라우저 API 라우트 (88L)
│   ├── security/             ← 보안 입력 검증
│   │   ├── path-guards.ts    ← assertSkillId, assertFilename, safeResolveUnder (60L)
│   │   └── decode.ts         ← decodeFilenameSafe (21L)
│   ├── http/                 ← 응답 계약
│   │   ├── response.ts       ← ok(), fail() 표준 응답 (25L)
│   │   ├── async-handler.ts  ← asyncHandler 래퍼 (14L)
│   │   └── error-middleware.ts ← notFoundHandler, errorHandler (26L)
│   └── command-contract/     ← 커맨드 인터페이스 통합
│       ├── catalog.ts        ← COMMANDS → capability map 확장 (39L)
│       ├── policy.ts         ← getVisibleCommands, getTelegramMenuCommands (37L)
│       └── help-renderer.ts  ← renderHelp list/detail mode (44L)
├── public/                   ← Web UI (ES Modules, 28 files, ~5500L)
│   ├── index.html            ← 뼈대 (469L, CLI-JAW 대문자 로고, pill theme switch, data-i18n)
│   ├── css/                  ← 6 files (~1724L)
│   │   ├── variables.css     ← Arctic Cyan 테마 + will-change + scrollbar tint (141L)
│   │   ├── layout.css        ← opacity 전환 + contain 격리 + 로고 글로우 (349L)
│   │   ├── markdown.css      ← rendering (table·code·KaTeX·Mermaid) + mermaid overlay popup + copy btn (269L)
│   │   ├── chat.css          ← 채팅 UI (메시지 버블·입력·첨부·스피너) (570L)
│   │   ├── sidebar.css       ← 사이드바 레이아웃 + 접기/펼치기 (224L)
│   │   └── modals.css        ← 모달·탭·설정 패널 (171L)
│   ├── locales/              ← i18n 로케일
│   │   ├── ko.json           ← 한국어 (178키)
│   │   └── en.json           ← 영어 (178키)
│   └── js/                   ← 19 files (~3250L)
│       ├── main.js           ← 앱 진입점 + 모듈 wire + 인덱스 탭 전환 (281L)
│       ├── render.js         ← marked+hljs+KaTeX+Mermaid 렌더러 + sanitize + mermaid overlay popup (294L)
│       ├── constants.js      ← CLI_REGISTRY 동적 로딩 + ROLE_PRESETS (119L)
│       ├── api.js            ← fetch 래퍼 + REST 엔드포인트 (55L)
│       ├── locale.js         ← 로케일 셀렉터 (23L)
│       ├── state.js          ← 전역 상태 (16L)
│       ├── ui.js             ← DOM 유틸 + 메시지 렌더링 (172L)
│       ├── ws.js             ← WebSocket 관리 (76L)
│       └── features/
│           ├── i18n.js       ← 프론트엔드 i18n + applyI18n() (125L)
│           ├── chat.js       ← 채팅 입력 + 파일 첨부 + 전송 (242L)
│           ├── employees.js  ← 직원 관리 UI (120L)
│           ├── heartbeat.js  ← Heartbeat 상태 표시 (80L)
│           ├── memory.js     ← 메모리 관리 UI (85L)
│           ├── settings.js   ← 설정 탭 UI (512L)
│           ├── skills.js     ← 스킬 관리 UI (68L)
│           ├── slash-commands.js ← 슬래시 커맨드 자동완성 (231L)
│           ├── sidebar.js    ← 사이드바 접기 (이중 모드) (88L)
│           ├── theme.js      ← pill switch 다크/라이트 (is-light class) (40L)
│           └── appname.js    ← Agent Name (DEFAULT_NAME='CLI-JAW') (43L)
├── bin/
│   ├── cli-jaw.ts           ← 12개 서브커맨드 라우팅
│   ├── postinstall.ts        ← npm install 후 5-CLI 자동설치 + MCP + 스킬 (259L)
│   └── commands/
│       ├── serve.ts          ← 서버 시작 (--port/--host/--open)
│       ├── chat.ts           ← 터미널 채팅 TUI (3모드, 블록아트 배너, active model 표시, 873L)
│       ├── init.ts           ← 초기화 마법사
│       ├── doctor.ts         ← 진단 (12개 체크, --json)
│       ├── status.ts         ← 서버 상태 (--json)
│       ├── mcp.ts            ← MCP 관리 (install/sync/list/reset)
│       ├── skill.ts          ← 스킬 관리 (install/remove/info/list/reset)
│       ├── employee.ts       ← 직원 관리 (reset, REST API 호출, 67L)
│       ├── reset.ts          ← 전체 초기화 (MCP/스킬/직원/세션)
│       ├── clone.ts           ← 인스턴스 복제 (--from, --with-memory, regenerateB) (165L)
│       ├── memory.ts         ← 메모리 CLI (search/read/save/list/init) (92L)
│       ├── launchd.ts        ← macOS LaunchAgent 관리 (instanceId, --port, xmlEsc) (179L)
│       └── browser.ts        ← 브라우저 CLI (17개 서브커맨드, 238L)
├── tests/                    ← 회귀 방지 테스트 (276 total · 275 pass)
│   ├── events.test.ts        ← 이벤트 파서 단위 테스트
│   ├── events-acp.test.ts    ← ACP session/update 이벤트 테스트
│   ├── telegram-forwarding.test.ts ← Telegram 포워딩 동작 테스트
│   ├── unit/                 ← Tier 1-2 단위 테스트 (~20 files)
│   │   ├── employee-prompt.test.ts ← 직원 프롬프트 14건
│   │   ├── orchestrator-parsing.test.ts ← subtask 파싱 13건
│   │   ├── orchestrator-triage.test.ts  ← triage 판단 10건
│   │   ├── agent-args.test.ts        ← CLI args 빌드 16건
│   │   ├── path-guards.test.ts       ← 입력 검증 16건
│   │   ├── http-response.test.ts     ← ok/fail 6건
│   │   ├── settings-merge.test.ts    ← deep merge 5건
│   │   ├── render-sanitize.test.ts   ← XSS sanitize 11건
│   │   └── ...
│   └── integration/
│       ├── cli-basic.test.ts         ← CLI 기본 통합
│       ├── api-smoke.test.ts         ← API 스모크 (서버 기동)
│       └── route-registration.test.ts ← 라우트 등록 스모크
├── README.md                 ← 영문 (기본, 언어 스위처)
├── README.ko.md              ← 한국어 번역
├── README.zh-CN.md           ← 중국어 번역
├── tsconfig.json             ← TypeScript 설정├── TESTS.md                  ← 테스트 상세
├── scripts/                  ← 도구 스크립트
│   ├── check-deps-offline.mjs ← 오프라인 취약 버전 체크
│   └── check-deps-online.sh  ← npm audit + semgrep
├── skills_ref/               ← 번들 스킬 (105개)
└── devlog/                   ← MVP 12 Phase + Post-MVP devlogs
```

### 런타임 데이터 (`~/.cli-jaw/`)

| 경로               | 설명                                      |
| ------------------ | ----------------------------------------- |
| `jaw.db`           | SQLite DB                                 |
| `settings.json`    | 사용자 설정                               |
| `mcp.json`         | 통합 MCP 설정 (source of truth)           |
| `prompts/`         | A-1, A-2, HEARTBEAT 프롬프트              |
| `memory/`          | Persistent memory (`MEMORY.md`, `daily/`) |
| `skills/`          | Active 스킬 (시스템 프롬프트 주입)        |
| `skills_ref/`      | Reference 스킬 (AI 참조용)                |
| `browser-profile/` | Chrome 사용자 프로필                      |
| `backups/`         | symlink 충돌 시 백업 디렉토리             |

npm 의존성: `express` ^4.21 · `ws` ^8.18 · `better-sqlite3` ^11.7 · `grammy` ^1.40 · `@grammyjs/runner` ^2.0 · `node-fetch` ^3.3 · `playwright-core` ^1.58

dev 의존성: `typescript` ^5.7 · `tsx` ^4.19 · `@types/node` ^22 · `@types/express` ^5 · `@types/better-sqlite3` ^7.6 · `@types/ws` ^8.5

---

## 코드 구조 개요

```mermaid
graph LR
    CLI["bin/commands/*"] -->|HTTP| SRV["server.ts"]
    WEB["public/"] -->|HTTP+WS| SRV
    SRV --> CORE["src/core/"]
    SRV --> AGT["src/agent/"]
    SRV --> ORC["src/orchestrator/"]
    SRV --> PRM["src/prompt/"]
    SRV --> MEM["src/memory/"]
    SRV --> TG["src/telegram/"]
    SRV --> BR["src/browser/"]
    SRV --> MCP["lib/mcp-sync.ts"]
    SRV --> CMD["src/cli/"]
    SRV --> RT["src/routes/"]
    SRV --> SEC["src/security/"]
    SRV --> HTTP["src/http/"]
    CMD --> CC["src/command-contract/"]
    CORE --> |config,db,bus,i18n| AGT
    CORE --> |config,db| ORC
    AGT --> EVT["agent/events.ts"]
    AGT --> ACP["cli/acp-client.ts"]
    ORC --> AGT
    TG --> ORC
    MEM --> |heartbeat| TG
```

### 디렉토리 의존 규칙 (Phase 20.6)

| 디렉토리                | 의존 대상                                      | 비고                                                                |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `src/core/`             | —                                              | 의존 0, 인프라 계층 (config, db, bus, logger, i18n, settings-merge) |
| `src/security/`         | —                                              | 의존 0, 입력 검증                                                   |
| `src/http/`             | —                                              | 의존 0, 응답 표준화                                                 |
| `src/browser/`          | —                                              | 독립 모듈, CDP 제어                                                 |
| `src/cli/`              | core, command-contract                         | 커맨드 레지스트리 + 핸들러 + ACP 클라이언트                         |
| `src/command-contract/` | cli/commands                                   | capability map + policy + help                                      |
| `src/prompt/`           | core                                           | A-1/A-2 + 스킬 + 직원 프롬프트 v2                                   |
| `src/memory/`           | core                                           | 메모리 + worklog + heartbeat                                        |
| `src/agent/`            | core, prompt, orchestrator, cli/acp-client     | 핵심 허브 + ACP copilot 분기                                        |
| `src/orchestrator/`     | core, prompt, agent                            | planning ↔ agent 상호 + phase 관리                                  |
| `src/telegram/`         | core, orchestrator, agent, cli, prompt, memory | 외부 인터페이스 + lifecycle                                         |
| `src/routes/`           | core, browser                                  | Express 라우트 추출                                                 |
| `server.ts`             | 전체                                           | 글루 레이어                                                         |

---

## 핵심 주의 포인트

1.  **큐**: busy 시 queue → agent 종료 후 자동 처리
2.  **세션 무효화**: CLI 변경 시 session_id 제거
3.  **직원 dispatch**: B 프롬프트에 JSON subtask 포맷
4.  **메모리 flush**: `forceNew` spawn → 메인 세션 분리, threshold개 메시지만 요약 (줄글 1-3문장) → [memory_architecture.md](str_func/memory_architecture.md) 참조
5.  **메모리 주입**: MEMORY.md = 매번, session memory = `injectEvery` cycle마다 (기본 x2)
6.  **에러 처리**: 429/auth 커스텀 메시지
7.  **IPv4 강제**: `--dns-result-order=ipv4first` + Telegram
8.  **MCP 동기화**: mcp.json → 5개 CLI 포맷 자동 변환 (Claude, Codex, Gemini, OpenCode, Copilot)
9.  **이벤트 dedupe**: Claude `stream_event`/`assistant` 중복 방지
10. **Telegram origin**: `origin` 메타 기반으로 포워딩 판단
11. **Forwarder lifecycle**: named handler attach/detach로 중복 등록 방지
12. **symlink 보호**: 실디렉토리 충돌 시 backup 우선
13. **CLI registry**: `src/cli/registry.ts`에서 5개 CLI 정의, `/api/cli-registry`로 동기화
14. **Copilot ACP**: JSON-RPC 2.0 over stdio, `session/update` 실시간 스트리밍
15. **Copilot effort**: `~/.copilot/config.json` `reasoning_effort` 직접 수정
16. **Copilot quota**: macOS keychain → `copilot_internal/user` API
17. **ACP ctx reset**: `loadSession()` 전 `ctx.fullText/toolLog/seenToolKeys` 초기화
18. **ACP activityTimeout**: idle 1200s + 절대 1200s 이중 타이머
19. **마크다운 렌더링**: CDN defer, CDN 실패 시 regex fallback
20. **marked v14 주의**: 커스텀 렌더러 API 토큰 기반 변경
21. **Copilot model sync**: `~/.copilot/config.json`에 model + effort 동기화
22. **activeOverrides**: Active CLI → `activeOverrides[cli]`, Employee → `perCli`만 참조
23. **Telegram chatId auto-persist**: `markChatActive()` → `allowedChatIds` 자동 저장
24. **Skills dedup**: `frontend-design`/`webapp-testing` 중복 제거 (104개)
25. **Skills i18n**: `getMergedSkills()` active 스킬에 `name_en`/`desc_en` 필드 통과
26. **[P9] 보안 가드**: path traversal, id injection, filename abuse 차단
27. **[P9] 응답 계약**: `ok(res, data)` / `fail(res, status, error)` 13개 라우트 적용
28. **[P9] settings merge**: `mergeSettingsPatch()` 분리
29. **[P9] command-contract**: capability map + `getTelegramMenuCommands()`
30. **[P9] deps gate**: `check-deps-offline.mjs` + `check-deps-online.sh`
31. **[P17] AI triage**: direct response → subtask JSON 감지 시 orchestration 재진입
32. **[P17.1] Dispatch 정책**: 진짜 여러 전문가 필요할 때만 dispatch
33. **[P17.3] Employee 명칭**: subagent → employee 통일
34. **[P17.4] HTML i18n**: 26키 추가, data-i18n 완전 한글화
35. **[P20.5] XSS 수정**: escapeHtml 인용부호 처리, 4개 모듈 패치
36. **[P20.6] 디렉토리 분리**: flat src/ → 12 subdirs, server.ts 850L
37. **[P20.6] promptCache**: `getEmployeePromptV2` 캐싱, orchestrate() 시 clear
38. **[i18n] 탭 전환**: textContent 영어 하드코딩 → 인덱스 기반 매칭 (다국어 호환)
39. **[i18n] 하드코딩 제거**: `render.js`/`settings.js` 4곳 → `t()` i18n 호출로 교체
40. **[dist] projectRoot**: `server.ts`/`config.ts`에서 `package.json` 위치 동적 탐색 (source/dist 양쪽 호환)
41. **[dist] serve.ts dual-mode**: `server.js` 존재 → node(dist), 없으면 tsx(source) 자동 감지
42. **[feat] Multi-file input**: `attachedFiles[]` 배열, 병렬 업로드, chip 프리뷰, 개별 제거
43. **[prompt] Dev skill rules**: A1_CONTENT에 `### Dev Skills (MANDATORY)` 서브섹션 추가 — 코드 작성 전 dev/SKILL.md 읽기 의무화
44. **[ux] 파일 경로 커맨드 오인 수정**: `parseCommand()`에서 첫 토큰에 `/` 포함 시 커맨드가 아닌 일반 텍스트로 판별
45. **[feat] History block 10**: `buildHistoryBlock()` `maxSessions` 5→10 (비-resume 세션에서 최근 대화 10개 불러옴, 8000자 제한 유지)
46. **[docs] README i18n**: 한국어/중국어 Hero 카피 리뉴얼 + 전체 톤 공식 문서 스타일로 격상
47. **[feat] Parallel dispatch**: `distribute.ts` 분리, `distributeByPhase()` parallel/sequential 분기, `Promise.all` 병렬 실행
48. **[fix] Employee list injection**: `buildPlanPrompt()`에 동적 employee 목록 주입 — planning agent가 정확한 에이전트 이름 사용
49. **[fix] No-JSON fallback**: planning agent가 JSON 없이 응답하면 direct answer로 처리 (silent failure 방지)
50. **[fix] Session invalidation 제거**: `regenerateB()`에서 세션 무효화 삭제 — 모든 CLI가 AGENTS.md 동적 reload 확인
51. **[rename] CLI-JAW**: cli-claw → cli-jaw 전체 리네임 (코드, 문서, 런타임 경로, API, 프롬프트)
52. **[theme] Arctic Cyan**: `--accent: #22d3ee`/`#06b6d4` (dark), `#0891b2`/`#0e7490` (light), 하드코딩 `#1a0a0a` → `color-mix()`
53. **[ux] Pill theme switch**: 이모지 ☀️/🌙 → CSS pill 토글 (moon crescent ↔ amber sun knob)
54. **[perf] Sidebar jank fix**: `display:none` → `opacity` 전환 + `contain: layout style` + `overflow:hidden`
55. **[ux] CLI 블록아트 배너**: `██╗` 스타일 CLIJaw ASCII art + active model(`/api/session`) 표시
56. **[ux] Logo uppercase**: 프론트엔드 로고 `CLI-JAW` 대문자, 이모지 없음
57. **[critical fix] activeOverrides 모델**: `spawn.ts:228`에서 planning/employee agent도 `activeOverrides` 모델 사용하도록 수정 — 이전에는 `agentId` 있으면 `perCli` 폴백 → config.json 모델 충돌 → Copilot 자동 취소 유발
58. **[config] 기본 permissions**: `config.ts` 기본값 `safe` → `auto` — Copilot ACP에서 safe 모드는 도구 승인 블로킹으로 자동 취소 유발
59. **[fix] Mermaid text invisible**: `sanitizeMermaidSvg()` removed — DOMPurify strips `<foreignObject>`/`<style>` tags needed by Mermaid v11 for text rendering. `mermaid.render()` with `securityLevel:'loose'` handles its own sanitization.
60. **[fix] Mermaid overlay duplicate buttons**: `openMermaidOverlay()` received `el.innerHTML` which included the zoom button. Fixed by saving raw SVG before appending zoom button.
61. **[fix] Mermaid overlay X button unresponsive**: `.mermaid-overlay-close` z-index 1→10, `pointer-events: auto`, `.mermaid-overlay-svg` z-index 0, added `stopPropagation()`+`preventDefault()`.
62. **[fix] Mermaid overlay too small**: `.mermaid-overlay-content` max-width 90vw→95vw, max-height 90vh→95vh, SVG maxHeight 80vh→85vh.
63. **[fix] User messages lost on refresh**: `POST /api/message` handler did not call `insertMessage.run()` before `orchestrate()`. WebSocket and queue paths saved correctly, but HTTP path was missing. Added `insertMessage.run('user', trimmed, 'web', '')` + `broadcast()`.
64. **[orch-v3] end_phase + checkpoint**: `initAgentPhases()`에 `end_phase` 파싱 + sparse fallback + `checkpoint`/`checkpointed` 필드 추가. Planning agent가 phase 범위(`start_phase: 3, end_phase: 3`)와 체크포인트 모드 지정 가능.
65. **[orch-v3] checkpoint branching**: 라운드 루프(2곳)에 checkpoint/done 분기 추가. `scopeDone && hasCheckpoint` → 세션 보존 + 유저 보고. `verdicts.allDone` 조기 완료 지원. verdict parse 실패 시 warn 로그.
66. **[orch-v3] _skipClear + continue**: `orchestrate()` 진입 2곳에 `_skipClear` 조건 적용. `orchestrateContinue`에서 `_skipClear: true` 전달 → 세션 복원. done/reset worklog은 continue 거부.
67. **[orch-v3] isResetIntent + orchestrateReset**: `parser.ts`에 `isResetIntent` 추가 (리셋/초기화/reset). `pipeline.ts`에 `orchestrateReset` 추가. `server.ts`/`bot.ts`에 WS/HTTP/Telegram reset 경로 추가. `/api/orchestrate/reset` 엔드포인트.
68. **[orch-v3] worklog ⏸ + allDone**: `updateMatrix`에 `⏸ checkpoint` 상태 추가. `parseWorklogPending`가 `⏸` 감지. review prompt에 allDone 조기 완료 규칙 추가.
69. **[orch-v3] planner schema**: `distribute.ts` `buildPlanPrompt`에 `end_phase`/`checkpoint` 가이드 + JSON 예시 추가.
70. **[critical fix] checkpoint completed reset**: `advancePhase`가 마지막 phase PASS 시 `completed=true` 찍는데, checkpoint 분기에서 `completed=false`로 되돌리지 않으면 matrix에 ✅ 표시되어 resume 불가.
71. **[multi-instance] Phase 1: workingDir default → JAW_HOME**: `config.ts:101` 기본값 `homedir()` → `JAW_HOME`. prompt_basic_A2에서도 `~/` → `~/.cli-jaw`.
72. **[multi-instance] Phase 2: JAW_HOME dynamic**: 8파일 import 중앙화 → `config.ts`. `CLI_JAW_HOME` env var + `--home` flag (manual indexOf, NOT parseArgs). postinstall `isDefaultHome` guard, init/mcp fallback.
73. **[multi-instance] Phase 3: jaw clone**: `bin/commands/clone.ts` (165L). source 검증(존재+settings.json), `--from`/`--with-memory`/`--link-ref`, subprocess `regenerateB`, fixture-based 테스트 8개.
74. **[multi-instance] Phase 3.1: Frontend hotfix**: workingDir 입력란 `value=""` + placeholder, Safe/Auto → Auto 고정 배지. `settings.js` setPerm() → no-op + always 'auto'.
75. **[multi-instance] Phase 4: launchd multi-instance**: `instanceId()` hash 기반 label (`com.cli-jaw.default` / `com.cli-jaw.<name>-<hash8>`), `xmlEsc()`, `parseArgs --port`, `--home`/`--port` plist pass-through, `CLI_JAW_HOME` env in plist, `WorkingDirectory → JAW_HOME`. `browser.ts`/`memory.ts` `getServerUrl('3457')` → `getServerUrl(undefined)`.
76. **[multi-instance] Phase 4.1 hotfix**: `applySettingsPatch` workingDir 변경 시 `regenerateB`+`ensureSkillsSymlinks`+`syncToAll` 후처리. 서버 시작 시 `safe→auto` 강제 마이그레이션. launchd unknown flag guard + plist path quoting. memory init 경로 JAW_HOME 동적화.

---

## 서브 문서

| 문서                                                        | 범위                                                                          | 파일                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| [🔧 infra.md](str_func/infra.md)                             | core/ (config·db·bus·logger·i18n·settings-merge) + security/ + http/          | 의존 0 계층 + Phase 9 보안/응답      |
| [🌐 server_api.md](str_func/server_api.md)                   | server.ts · routes/ · REST API · WebSocket                                    | 라우트 + 40+ 엔드포인트 + guards     |
| [⚡ commands.md](str_func/commands.md)                       | cli/ (commands·handlers·registry) + command-contract/                         | 레지스트리 + 디스패처 + capability   |
| [🤖 agent_spawn.md](str_func/agent_spawn.md)                 | agent/ (spawn·args·events) + orchestrator/ (pipeline·parser) + cli/acp-client | spawn + ACP + 오케스트레이션         |
| [📱 telegram.md](str_func/telegram.md)                       | telegram/ (bot·forwarder) + memory/heartbeat                                  | 외부 인터페이스 + lifecycle + origin |
| [🎨 frontend.md](str_func/frontend.md)                       | public/ 전체 (~25파일, i18n 포함)                                             | ES Modules + CSS + 동적 registry     |
| [🧠 prompt_flow.md](str_func/prompt_flow.md)                 | prompt/builder.ts · 직원 프롬프트 · promptCache                               | **핵심** — 정적/동적 + Copilot ACP   |
| [📄 prompt_basic_A1.md](str_func/prompt_basic_A1.md)         | A-1 기본 프롬프트 원문                                                        | EN 기본 프롬프트 레퍼런스            |
| [📄 prompt_basic_A2.md](str_func/prompt_basic_A2.md)         | A-2 프롬프트 템플릿                                                           | 사용자 편집 가능                     |
| [📄 prompt_basic_B.md](str_func/prompt_basic_B.md)           | B 프롬프트 원문 (직원 규칙, 위임 정책)                                        | 직원 레퍼런스                        |
| [💾 memory_architecture.md](str_func/memory_architecture.md) | 3계층 메모리 시스템 (History Block · Flush · Injection)                       | 메모리 전체 구조 레퍼런스            |

---

## Devlog

**완료 아카이브** (`devlog/_fin/`): mvp P01~12, 250225_acp-parity, 260223_권한 P1~13, 260223_모델, 260223_프론트엔드 모듈화, 260223_서브에이전트프롬프트, 260224_cmd P0~P6, 260224_orch P0~P5, 260224_skill P0~P2, 260224_vision P1~P2, 260225_copilot-cli-integration P1~P6, 260225_esbuild_번들러_도입, 260225_finness P0~P20.6, 260226_fallback

**진행 중** (`devlog/`):

| 폴더                              | 주제                                                                                       | 상태 |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| `260225_debug/`                   | i18n + multifile + dev skill + filepath fix + parallel dispatch + session fix              | ✅    |
| `260225_clijaw_rename/`           | cli-claw→cli-jaw 리네임 + Arctic Cyan 테마 + CLI 블록아트 배너                             | ✅    |
| `260225_mermaid_bugs/`            | Mermaid text invisible (DOMPurify foreignObject strip) + overlay UX + user msg persistence | ✅    |
| `260225_cross_platform/`          | 크로스 플랫폼 호환 패치 (browser serve, doctor, postinstall config)                        | 🟡    |
| `260225_workdir_refactor/`        | Multi-instance refactor Phase 1-4.1 (workingDir, JAW_HOME, clone, launchd, frontend)      | ✅    |
| `260226_session_cleanup/`         | Orchestration v3: end_phase + checkpoint + reset + session lifecycle                       | 🟡    |
| `260226_steer_interrupted/`       | steer 중단 시 부분 결과 저장 조사                                                          | 🟡    |
| `devlog_ts/`                      | TypeScript 빌드 호환 (dist build, import ext fix)                                          | 🟡    |
| `269999_메모리 개선/`             | 메모리 고도화 (flush✅ + vector DB 📋 후순위)                                                | 🔜    |

---

> 프로젝트 전체 파일 검증 완전 레퍼런스. 상세는 서브 문서 참조.
