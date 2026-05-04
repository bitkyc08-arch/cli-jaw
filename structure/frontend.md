---
created: 2026-03-28
tags: [cli-jaw, frontend, vite, pwa]
aliases: [CLI-JAW Frontend, public architecture, frontend.md]
---

> 📚 [INDEX](INDEX.md) · [커맨드](commands.md) · [서버 API](server_api.md) · **프론트엔드 아키텍처**

# Frontend — `public/`

> Web UI 본체는 Vanilla HTML + CSS + TypeScript ES Modules로 구성된다. Manager 대시보드는 `public/manager/`의 React 19 + TSX 앱이다.
> 빌드는 Vite 8 기준이며, `vite.config.ts`는 `public/index.html`과 `public/manager/index.html`을 multi-entry로 빌드한다.
> 현재 `public/`에서 `public/dist/*`를 제외한 소스/자산/legacy duplicate는 404개다. `public/public/dist/*`까지 generated로 보면 실제 편집 대상 소스/자산은 277개다. 생성 산출물은 `public/dist/` 455개와 별도 중복 트리 `public/public/dist/` 127개가 남아 있고, `public/dist/dist/`는 전자에 재귀 포함된 nested 복제본이다.
> 메인 UI는 `index.html`에서 Google Fonts `Chakra Petch` + `Outfit`을 불러오고, 로컬 `public/assets/fonts/GeistVF.woff2`와 `JetBrainsMono-Variable.woff2`는 자산으로 보관 중이다.
> PWA는 `manifest.json` + `sw.js` + `icons/`로 구성된다. 오프라인 메시지 캐시, virtual scroll, markdown/KaTeX/Mermaid 렌더링, sandboxed diagram widget, avatar emoji/image 커스터마이즈, voice recording, PABCD roadmap, subagent-aware ProcessBlock 렌더링, 반응형 사이드바, theme toggle이 현재 런타임의 핵심이다.

---

## 파일 구조

```text
public/
├── index.html            ← 메인 UI 엔트리
├── manifest.json         ← PWA 매니페스트
├── sw.js                 ← Service Worker 캐시 전략
├── theme-test.html       ← 테마 점검 페이지
├── assets/
│   ├── fonts/            ← 2 fonts (GeistVF, JetBrainsMono variable)
│   ├── providers/        ← 10 SVG provider assets
│   └── shark.svg
├── css/                  ← 9 CSS files
├── icons/                ← 3 PWA icons
├── img/                  ← shark sprite
├── js/                   ← 52 TypeScript modules
│   ├── diagram/          ← 3 diagram pipeline modules
│   └── features/         ← 32 feature modules
├── locales/              ← ko/en/ja/zh JSON bundles
├── manager/              ← React manager dashboard + notes/settings workspaces (191 files)
│   ├── index.html        ← Manager HTML entry
│   └── src/              ← React components/hooks/styles
└── dist/                 ← Vite build output (generated, nested dist copies remain)
```

### 파일 수 요약

| 영역 | 파일 수 | 비고 |
| --- | ---: | --- |
| `public/` source/assets | 404 | 문서 관례상 `public/dist/*`만 제외, `public/public/dist/*`는 포함 |
| `public/` source/assets (generated 제외) | 277 | `public/dist/*`, `public/public/dist/*` 모두 제외 |
| `public/js/` root | 17 | 전부 TypeScript ES modules, `mermaid-loader.ts`, `uuid.ts`, `virtual-scroll-bootstrap.ts` 포함 |
| `public/js/diagram/` | 3 | SVG/iframe diagram pipeline |
| `public/js/features/` | 32 | settings 분해 + help/attention/orchestrate scope + process-step-match 포함 |
| `public/manager/` | 191 | React 19 manager dashboard, notes, schedule, settings, sync, WYSIWYG source |
| `public/css/` | 9 | theme/layout/chat/markdown/tool UI/diagram |
| `public/locales/` | 4 | `ko.json`, `en.json`, `ja.json`, `zh.json` |
| `public/assets/providers/` | 10 | provider SVG 세트 |
| `public/assets/fonts/` | 2 | 로컬 폰트 자산 |
| `public/icons/` | 3 | PWA icons |
| `public/dist/` | 455 | generated build output, nested `dist/dist` 포함 |
| `public/public/dist/` | 127 | old build duplicate |
| `public/dist/dist/` | 127 | old build duplicate |

> 참고: `public/dist/` 455개에는 `public/dist/dist/` 127개가 이미 재귀 포함된다. 그래서 별도 루트 기준으로 보면 현재 남아 있는 build tree는 `public/dist/`와 `public/public/dist/` 두 갈래다.

---

## 핵심 모듈

### Bootstrap / Runtime

| 파일 | 역할 |
| --- | --- |
| `js/main.ts` | 앱 부트스트랩. 아이콘/프로바이더 아이콘 hydrate, i18n 초기화, CLI registry 로드, WS 연결, 드래그앤드롭, auto-resize, commands/settings/employees/heartbeat/memory/app name/avatar/sidebar/theme/gesture 바인딩, production에서 SW 등록 |
| `js/state.ts` | 공유 상태 저장소. WS, agent busy, attached files, heartbeat jobs/errors, CLI status cache, recording, `currentAgentDiv`, `currentProcessBlock` |
| `js/constants.ts` | CLI registry 동적 로딩, provider/model 매핑, CLI 메타 데이터 |
| `js/api.ts` | `api`, `apiJson`, `apiFire` fetch 래퍼 |
| `js/locale.ts` | localStorage 기반 locale 동기화 |
| `js/icons.ts` | Lucide 기반 중앙 아이콘 레지스트리 + emoji compatibility. `ICONS.robot`/`ICONS.tool` 등 ProcessBlock summary와 row icon에 재사용 |
| `js/provider-icons.ts` | provider SVG raw import + hydrate helper + label lookup |
| `js/uuid.ts` | virtual scroll와 live append가 공유하는 DOM-safe id 생성기 |

### Rendering / UI

| 파일 | 역할 |
| --- | --- |
| `js/render.ts` | marked + highlight.js + KaTeX + Mermaid + diagram-html widget rendering, SVG/HTML sanitization, orchestration stripping, local file-path linkification + open interception, lazy Mermaid refresh, 100ms batched post-render debounce |
| `js/ui.ts` | 메시지 렌더링, skeleton/empty state, virtual scroll 연동, ProcessBlock 오케스트레이션, subagent/tool step merge + dedup, copy button, markdown/file-path post-render linkification, avatar markup 주입, message finalization, bottom-follow intent helper |
| `js/ws.ts` | WebSocket 메시지 라우팅. agent status, queue update, `agent_tool`→typed ProcessStep, agent output/done, orchestration state, Telegram/Discord new message, reconnect snapshot, 10초 reload dedup, reconnect 후 bottom anchor reconciliation |
| `js/streaming-render.ts` | 스트리밍 텍스트 렌더러 |
| `js/virtual-scroll-bootstrap.ts` | virtual scroll 초기 hydrate/measure/bootstrap 오케스트레이터 |
| `js/virtual-scroll.ts` | TanStack virtualizer 기반 DOM 풀링, mounted node 재사용, post-render hook 실행, pageshow/visibility/focus 복귀 시 bottom-follow intent reconciliation |
| `js/sanitizer.ts` | DOMPurify singleton + SVG/HTML attribute hook boundary. `render.ts`는 이 adapter를 통해서만 sanitizer 인스턴스를 사용한다 |
| `js/cjk-fix.ts` | CJK 줄바꿈/구두점 보정 |

### Runtime Hardening Invariants

| 영역 | invariant |
| --- | --- |
| Web UI runtime tests | `tests/unit/web-ui-test-dom.ts`가 jsdom window/document/observer globals를 먼저 설치하고, frontend modules는 dynamic import한다 |
| ProcessBlock DOM recovery | `.process-step` row는 `data-step-id`, `data-type`, `data-status`, `data-step-ref`, `data-start-time`을 보존한다. DOM에서 복구한 `ProcessBlockState`는 `element`, `steps`, `collapsed`를 유지한다 |
| ProcessBlock ownership | assistant message의 tool UI는 `.agent-body > .process-block` 또는 legacy `.agent-body > .tool-group` 하나만 허용되며 `.msg-content` 내부 tool block은 normalize 단계에서 제거/승격된다 |
| Mermaid lifecycle | virtual-scroll unmount/deactivate 전 `releaseMermaidNodes()`가 pending/queued/in-flight Mermaid nodes를 observer에서 해제하고 transient markers를 제거한다 |
| Build output guard | `npm run check:frontend-build-output`가 built app entry에서 eager Mermaid/vendor-utils reference를 차단하고 lazy `mermaid-loader` dynamic import는 허용한다 |

### Diagram Pipeline

| 파일 | 역할 |
| --- | --- |
| `js/diagram/types.ts` | SVG block 추출, code-fence shielding/unshielding |
| `js/diagram/iframe-renderer.ts` | sandboxed iframe widget renderer, CSP/importmap/bridge script, copy/save 버튼, theme sync |
| `js/diagram/widget-validator.ts` | diagram-html 검증. 위험 패턴 차단 + CDN allowlist 검사 |

### Feature Modules

| 파일 | 역할 |
| --- | --- |
| `js/features/avatar.ts` | agent/user avatar emoji 저장 + image upload/reset, `/api/avatar*` 동기화, `.agent-icon`/`.user-icon` DOM 갱신 |
| `js/features/appname.ts` | sidebar agent name만 localStorage로 저장. 로고/헤더 타이틀은 고정 `CLI-JAW` |
| `js/features/attention-badge.ts` | window focus/visibility 기반 unread/attention badge |
| `js/features/chat.ts` | send, slash command dispatch, multi-file attachment upload, stop-mode, clear chat, auto-resize, voice send integration |
| `js/features/employees.ts` | employee CRUD + CLI/model/role 조정 |
| `js/features/gesture.ts` | 모바일 edge swipe sidebar toggle |
| `js/features/heartbeat.ts` | heartbeat job editor, cron/every + timezone validation, sidebar badge |
| `js/features/help-content.ts` | help dialog topic content registry |
| `js/features/help-dialog.ts` | help trigger binding + modal rendering |
| `js/features/i18n.ts` | 프론트엔드 번역 bootstrap + `t()` |
| `js/features/idb-cache.ts` | IndexedDB conversation cache — DB v3, scope-based (workingDir), incremental upsert, version-aware migration, versionchange handler |
| `js/features/memory.ts` | basic memory + advanced memory modal/indexing UI |
| `js/features/orchestrate-scope.ts` | PABCD/orchestration scope display helper |
| `js/features/pending-queue.ts` | queued prompt overlay / pending queue 렌더 |
| `js/features/process-block.ts` | collapsible ProcessBlock UI. `tool`/`thinking`/`search`/`subagent` step type, type별 summary, trusted icon 렌더링, expandable detail row |
| `js/features/settings-channel.ts` | active channel + fallback order |
| `js/features/settings-cli-status.ts` | CLI availability/quota/status, Copilot keychain refresh |
| `js/features/settings-core.ts` | settings load/update, per-CLI model/effort, locale sync, Claude 1M / Codex fast/context controls |
| `js/features/settings-discord.ts` | Discord settings save/load/toggles |
| `js/features/settings-mcp.ts` | MCP server list/sync/install |
| `js/features/settings-stt.ts` | STT engine/provider fields, gemini/openai/vertex/whisper wiring |
| `js/features/settings-telegram.ts` | Telegram settings save/load/toggles |
| `js/features/settings-templates.ts` | prompt/template tree + editor + dev mode |
| `js/features/settings-types.ts` | shared settings interfaces |
| `js/features/settings.ts` | barrel re-export |
| `js/features/sidebar.ts` | responsive collapse/expand, narrow overlay behavior, arrow sync |
| `js/features/skills.ts` | skill load/filter/toggle |
| `js/features/slash-commands.ts` | web slash command dropdown + file-path guard |
| `js/features/theme.ts` | dark/light theme toggle, hljs theme swap, Mermaid/iframe refresh |
| `js/features/tool-ui.ts` | legacy finalized tool group + live activity helper. 현재 assistant tool history는 주로 ProcessBlock HTML로 렌더링 |
| `js/features/voice-recorder.ts` | MediaRecorder wrapper, MIME detection, error classification, timer |

### Settings Split

`settings.ts`는 더 이상 모놀리스가 아니라 barrel 역할만 한다. 실제 상태/저장 로직은 아래처럼 분리되어 있다.

```text
settings.ts
├─ settings-core.ts
├─ settings-telegram.ts
├─ settings-discord.ts
├─ settings-channel.ts
├─ settings-mcp.ts
├─ settings-cli-status.ts
├─ settings-stt.ts
├─ settings-templates.ts
└─ settings-types.ts
```

---

## CSS 시스템

| 파일 | 역할 |
| --- | --- |
| `css/variables.css` | 컬러/타이포/spacing/easing token, light/dark variables, reveal animations |
| `css/layout.css` | 전체 grid layout, sidebar width, base UI scaffolding |
| `css/chat.css` | chat area, message layout, input bar, attachments, voice button, theme switch, virtual scroll container, `.file-path-link` open states (`opening/opened/open-failed`) |
| `css/orc-state.css` | PABCD roadmap, shark runner, orc glow, state badge |
| `css/sidebar.css` | left/right sidebar, collapse behavior, status / CLI / app name sections |
| `css/modals.css` | prompt/template/heartbeat/memory modal shells + form controls |
| `css/markdown.css` | markdown rendering, code block, copy button, tables, mermaid/KaTeX styles |
| `css/tool-ui.css` | tool call group, live activity, ProcessBlock summary/row/detail, subagent badge, row icon column |
| `css/diagram.css` | diagram container, widget iframe, overlay, zoom/copy/save buttons |

### 현재 CSS 동작

| 기능 | 구현 사실 |
| --- | --- |
| 테마 | 기본 dark, `[data-theme="light"]`로 light override. `theme.ts`가 `hljs` 스타일도 교체 |
| 폰트 | `--font-display`, `--font-ui`, `--font-mono` 조합. 메인 화면은 Google Fonts 기반, 로컬 폰트는 자산으로만 보관 |
| 채팅 레이아웃 | agent 메시지는 bubble 대신 `agent-icon + agent-body` 2컬럼 구조 |
| 아바타 | emoji 입력 저장 + PNG/JPEG/WebP/GIF 업로드 버튼이 sidebar settings에 통합되어 있고, 이미지 활성 시 `.avatar-image`로 렌더링 |
| 성능 | `.chat-messages` `contain: content`, `.msg` `contain: layout style`로 reflow 격리 |
| PABCD | roadmap visibility, shark sprite animation, state glow는 `orc-state.css`가 담당 |
| Diagram | widget/overlay/copy/save/zoom 버튼은 `diagram.css`와 `diagram/iframe-renderer.ts`가 함께 처리 |

---

## Manager Dashboard — `public/manager/`

`public/manager/`는 메인 채팅 UI와 별개의 React 19 앱이다. `vite.config.ts`의 `manager` entry가 `public/manager/index.html`을 빌드하고, HTML은 `/manager/src/main.tsx`를 로드한다.

| 파일/폴더 | 역할 |
| --- | --- |
| `manager/index.html` | `#manager-root`와 `/manager/src/main.tsx`를 가진 Manager HTML entry |
| `manager/src/main.tsx` | `react-dom/client` `createRoot()`로 `App` 렌더 |
| `manager/src/App.tsx` | instance scan/filter/select/lifecycle + dashboard section 상태 orchestration |
| `manager/src/api.ts` | `/api/dashboard/instances`, `/api/dashboard/registry`, `/api/dashboard/lifecycle/:action` fetch wrapper |
| `manager/src/components/` | `ManagerShell`, `WorkspaceLayout`, `Instance*`, `Command*`, `ActivityDock`, `MobileNav` 등 dashboard UI |
| `manager/src/hooks/` | dashboard registry/view persistence hooks |
| `manager/src/*.css` | manager 전용 layout/components/persistence/polish/styles |

Manager 서버는 `jaw dashboard serve`가 실행하는 `src/manager/server.ts`이며 기본 port는 `24576`, 기본 scan 범위는 `3457`부터 50개다.

---

## ProcessBlock / Subagent Rendering

subagent 렌더링 변경 이후 tool history의 canonical UI는 `features/process-block.ts`다. `ui.ts`는 live WS 이벤트, persisted `tool_log`, IndexedDB fallback, virtual-scroll history 모두를 `ToolLogEntry[]` -> `ProcessStep[]` -> ProcessBlock HTML 흐름으로 맞춘다.

| 관심사 | 현재 구현 |
| --- | --- |
| 타입 보존 | `ws.ts`는 `msg.toolType === 'subagent'`를 `ProcessStep.type = 'subagent'`로 넘기고, `ui.ts`의 `processStepType()`도 persisted `toolLog.toolType`에서 `subagent`를 보존한다. unknown type만 `tool`로 떨어진다. |
| Summary split | `process-block.ts`의 summary는 type별로 `Thinking`, `Search`, `Subagent`, `Tool`을 따로 count한다. 그래서 subagent rows는 generic Tool count에 섞이지 않는다. |
| row layout | `tool-ui.css`의 `.process-step-toggle`은 `auto 16px auto minmax(0, 1fr) auto` grid다. dot 다음에 고정 16px `.process-step-icon` column이 있고, badge/label/chevron은 별도 column에 놓인다. |
| rawIcon / SVG policy | `ws.ts`와 `ui.ts`는 merge/dedup용 provenance로 `rawIcon`을 보존한다. 표시용 `step.icon`은 `emojiToIcon()`으로 local Lucide/custom SVG를 우선 만들고, `process-block.ts`의 `renderTrustedIcon()`은 `<svg...`로 시작하는 값만 SVG로 삽입하며 나머지는 escape한다. |
| running -> done merge | `showProcessStep()`는 done/error 이벤트가 오면 먼저 같은 `stepRef`의 running row를 찾고, 없으면 같은 label의 running row를 찾는다. 매칭되면 기존 row id를 유지하고 detail을 병합해서 `replaceStep()`한다. |
| done-only fallback blocking | `stepRef`가 있는 done/error 이벤트는 legacy "아무 running row 닫기" fallback을 타지 않는다. fallback은 `!step.stepRef`인 uncorrelated legacy tool 이벤트에만 허용되어 다른 subagent running row를 닫지 않는다. |
| repeated done-only dedup | 같은 `stepRef`의 done/error row가 이미 있으면 새 row를 추가하지 않고 기존 done/error row를 `replaceStep()`로 갱신한다. |
| ghost replacement | detail 있는 재broadcast가 같은 label+type의 detail 없는 running ghost를 만나면 해당 row를 교체한다. |
| finalization | `finalizeAgent()`는 live ProcessBlock 또는 canonical DOM block이 이미 있던 응답에서는 static tool HTML을 다시 붙이지 않는다. static tool HTML은 `.msg-content` 안이 아니라 `.agent-body > .process-block` 위치에만 둔다. |
| single-owner invariant | assistant message의 tool history는 `.agent-body > .process-block` 또는 legacy `.agent-body > .tool-group` 하나만 허용한다. `normalizeAgentToolBlocks()`가 finalize/hydrate/live-step/virtual-scroll serialization 전에 중첩 `.msg-content > .process-block`과 duplicate block을 정리한다. |
| lazy history render | virtual-scroll history item은 raw markdown `data-raw`와 escaped raw `data-tool-log`만 저장한다. markdown과 tool-log ProcessBlock detail HTML은 mounted lazy render 시점에 만들고 `body.dataset.toolLog`를 삭제한다. |
| mermaid cleanup | `virtual-scroll.ts`는 unmount/deactivate 전에 `releaseMermaidNodes()`를 호출해 `.mermaid-pending` observer target과 transient queue flags를 해제한다. |
| vendor chunk split | Mermaid는 `public/js/mermaid-loader.ts` lazy path 뒤에 둔다. `vite.config.ts`는 강제 `vendor-mermaid` manual chunk를 만들지 않고, lodash-es/d3/chevrotain만 `vendor-utils`로 분리해 app entry의 Mermaid/static utility hoist를 줄인다. |

`tool-ui.ts`의 `buildToolGroupHtml()`/`.tool-group` CSS는 여전히 남아 있지만, 현재 `ui.ts`의 assistant history/finalization path는 `buildProcessBlockHtml()`을 사용한다. 그래서 새 subagent semantics는 `process-block.ts`, `ui.ts`, `ws.ts`, `icons.ts`, `tool-ui.css`가 함께 담당한다.

### Drift / Line Counts

이번 점검 기준 관련 파일 라인 수는 아래와 같다.

| 파일 | 현재 라인 수 | drift 메모 |
| --- | ---: | --- |
| `public/js/ws.ts` | 469L | `WsMessage`가 `toolType`, `detail`, `stepRef`, `isEmployee`를 받고 `agent_tool`을 typed ProcessStep으로 변환. reconnect 시 snapshot hydration과 bottom reconciliation 호출 |
| `public/js/ui.ts` | 940L | ProcessBlock single-owner normalize, merge/dedup, active-run hydrate, lazy history markdown/tool-log render, bottom-follow intent helper가 포함되어 기존 단순 DOM util 설명보다 넓어짐 |
| `public/js/main.ts` | 512L | bootstrap + event binding이 집중되어 500L를 넘음 |
| `public/js/render.ts` | 1081L | markdown/KaTeX/Mermaid/diagram/file-path/post-render 책임이 모두 모여 있고, Mermaid observer release helper를 export함 |
| `public/js/virtual-scroll.ts` | 504L | TanStack virtualizer activation, mounted row remeasure, Mermaid observer release before unmount/deactivate, `pageshow`/`visibilitychange`/`focus` 복귀 후 near-bottom일 때 bottom reconciliation |
| `public/js/features/process-block.ts` | 272L | `subagent` type, type별 summary, trusted SVG row icon, expandable row detail |
| `public/js/features/process-step-match.ts` | 18L | ProcessStep matching helper |
| `public/js/features/tool-ui.ts` | 116L | legacy tool group/live activity helper로 축소 설명 필요 |
| `public/js/icons.ts` | 278L | Lucide registry + emoji compatibility + `robot`/`tool` ProcessBlock icon source |
| `public/css/tool-ui.css` | 548L | legacy tool group뿐 아니라 ProcessBlock layout/style 대부분 포함 |
| `public/js/state.ts` | 89L | `currentProcessBlock` + `currentAgentDiv` shared runtime state |
| `public/manager/src/App.tsx` | 625L | Manager dashboard state orchestration |

---

## PWA / Assets

| 자산 | 현재 구현 |
| --- | --- |
| `manifest.json` | `standalone`, `theme_color: #22d3ee`, 192/512/maskable icons |
| `sw.js` | navigation network-first, `/dist/assets/*` cache-first, 그 외 stale-while-revalidate |
| `icons/` | `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` |
| `assets/providers/` | `claude`, `claude-color`, `copilot`, `copilot-color`, `gemini`, `gemini-color`, `openai`, `opencode`, `discord`, `telegram` |
| `assets/fonts/` | `GeistVF.woff2`, `JetBrainsMono-Variable.woff2` |
| `assets/shark.svg`, `img/shark-sprite.png` | shark brand/sprite assets |
| `locales/` | `ko.json`, `en.json` |
| `theme-test.html` | 독립 테마 진단 페이지. Google Fonts + mock sidebar/chat samples |

### Provider Icons

`provider-icons.ts`는 raw SVG를 직접 import해서 `cli-status`, `headerCli`, memory/skills/agents UI에 재사용한다. `codex`는 OpenAI 계열 아이콘을, `openai`는 GPT/O 계열 이름까지 alias로 묶는다.

### Locale Behavior

`locale.ts`는 `claw_locale` / `claw.locale` 둘 다 동기화한다. `main.ts`는 bootstrap 시 i18n을 먼저 올리고, `ws.ts`는 reconnect 시 `?lang=` 쿼리로 locale을 넘긴다.

---

## 현재 런타임 흐름

| 단계 | 구현 사실 |
| --- | --- |
| 초기화 | `hydrateIcons()` → `hydrateProviderIcons()` → `initI18n()` → `loadCliRegistry()` → `connect()` → `initAvatar()` + pending/help/attention 초기화 |
| 입력 | slash command dropdown, file attachment, drag/drop, auto-resize, voice record/cancel |
| 전송 | 일반 메시지는 `/api/message`, slash command는 `/api/command`, stop 버튼은 `/api/stop` |
| 업로드 | 첨부 파일은 병렬 업로드 후 prompt에 합성 |
| 렌더링 | `render.ts`가 markdown/KaTeX/Mermaid/code copy/diagram widget과 local file-path click-to-open 링크를 담당하고, post-render 작업은 100ms debounce로 합쳐진다 |
| 오프라인 | `idb-cache.ts`가 메시지 히스토리를 IndexedDB에 보관 — scope별 캐시(workingDir), 실시간 upsert, 서버 다운 시 캐시 복원 + tool_log process block 렌더 |
| 아바타 | `initAvatar()`가 localStorage emoji와 `/api/avatar` 서버 상태를 합쳐 agent/user 아이콘을 hydrate하고, 업로드는 `/api/avatar/:target/upload`, reset은 `/api/avatar/:target/image` `DELETE`로 처리한다 |
| WS | `agent_tool`은 typed ProcessBlock step으로, `agent_output`은 streaming renderer로, `agent_done`은 finalization으로 흘러가며, reconnect 직후 10초 이내에는 중복 `loadMessages()`를 건너뛴다 |
| 상태 | `agent_status`, `queue_update`, `orc_state`, `session_reset`, `clear`, Telegram/Discord `new_message`를 처리한다 |
| 반응형 | sidebar collapse/expand, mobile edge swipe, mobile nav, theme switch, PABCD roadmap, voice shortcut(`Ctrl/Cmd+Shift+Space`) 지원 |
| Manager | 별도 React 앱이 dashboard API로 Jaw 인스턴스 scan/preview/lifecycle 관리 |

### 주의할 점

`public/dist/`, `public/public/dist/`, `public/dist/dist/`는 모두 같은 Vite 산출물 계열이다. 현재 repo에는 root duplicate 하나(`public/public/dist/`)와 nested duplicate 하나(`public/dist/dist/`)가 함께 남아 있지만, 실제 소스 구조 설명에서는 `public/dist/`를 대표 build output으로 보는 것이 맞다.

메인 채팅 UI에 React가 도입된 것은 아니다. React는 `public/manager/` dashboard에만 사용된다.

### 최근 프런트엔드 변경 메모

- `db9179f feat: avatar image upload support (#95)` 이후 Web UI는 emoji뿐 아니라 image avatar도 지원하며, 프런트엔드와 `/api/avatar*` 라우트가 함께 추가됐다.
- `7ade8e5` 이후 virtual scroll은 viewport child를 재사용하고 `onPostRender` hook에서 widget activation/linkification을 처리한다.
- `a42de89` 이후 virtual scroll live append id 안정성과 runtime path hardening이 같이 들어가, 서비스 재기동 직후에도 avatar/image path와 UI append 흐름이 덜 깨지도록 보강됐다.
- 2026-04-24 subagent rendering 반영: `toolType: 'subagent'` 보존, summary Tool/Subagent split, stepRef 기반 running->done merge, done-only fallback 제한, repeated done-only dedup, ProcessBlock row icon column, rawIcon/trusted SVG 정책을 문서화했다.
