---
created: 2026-03-28
tags: [cli-jaw, frontend, vite, pwa]
aliases: [CLI-JAW Frontend, public architecture, frontend.md]
---

> 📚 [INDEX](INDEX.md) · [커맨드](commands.md) · [서버 API](server_api.md) · **프론트엔드 아키텍처**

# Frontend — `public/`

> Web UI 본체는 Vanilla HTML + CSS + TypeScript ES Modules로 구성된다. Manager 대시보드는 `public/manager/`의 React 19 + TSX 앱이다.
> 빌드는 Vite 8 기준이며, `vite.config.ts`는 `public/index.html`과 `public/manager/index.html`을 multi-entry로 빌드한다.
> 메인 UI는 `index.html`에서 Google Fonts `Chakra Petch` + `Outfit`을 불러오고, 로컬 `public/assets/fonts/GeistVF.woff2`와 `JetBrainsMono-Variable.woff2`는 자산으로 보관 중이다.
> PWA는 `manifest.json` + `sw.js` + `icons/`로 구성된다. 오프라인 메시지 캐시, virtual scroll, markdown/KaTeX/Mermaid 렌더링, sandboxed diagram widget, avatar emoji/image 커스터마이즈, voice recording, SSE-first event-channel, PABCD roadmap, subagent-aware ProcessBlock 렌더링, slash command 복구 액션, 반응형 사이드바, theme toggle, chat search, workflow cockpit이 현재 런타임의 핵심이다.

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
│   ├── providers/        ← 18 SVG provider assets
│   └── shark.svg
├── css/                  ← 12 CSS files
├── icons/                ← 3 PWA icons
├── img/                  ← shark sprite
├── js/                   ← 90 TypeScript modules
│   ├── diagram/          ← 3 diagram pipeline modules
│   ├── features/         ← 51 feature modules
│   └── render/           ← 18 markdown/diagram rendering modules
├── locales/              ← ko/en/ja/zh JSON bundles
├── manager/              ← React manager dashboard (300 source files under src)
│   ├── index.html        ← Manager HTML entry
│   └── src/              ← React components/hooks/styles
└── dist/                 ← Vite build output (generated)
```

### 파일 수 요약

| 영역 | 파일 수 | 비고 |
| --- | ---: | --- |
| `public/` source/assets (generated 제외) | 434 | `public/dist/*`, `public/public/dist/*` 모두 제외 |
| `public/js/` root | 19 | TypeScript ES modules |
| `public/js/diagram/` | 3 | SVG/iframe diagram pipeline |
| `public/js/render/` | 18 | markdown/KaTeX/Mermaid/SVG/file-link/post-render/structured card renderer 책임 분리 |
| `public/js/features/` | 52 | settings 분해 + help/attention/orchestrate scope + process-step-match + preview shortcut/invalidate bridge + MCP registry + chat-search + workflow-event-adapter + media-lightbox + elicitation-state + Pi settings + project git header status 포함 |
| `public/manager/src/` | 300 | React 19 manager dashboard |
| `public/css/` | 12 | theme/layout/chat/markdown/tool UI/diagram/trace drawer/workflow cockpit/chat-search |
| `public/locales/` | 4 | `ko.json`, `en.json`, `ja.json`, `zh.json` |
| `public/assets/providers/` | 18 | provider SVG 세트 |
| `public/assets/fonts/` | 2 | 로컬 폰트 자산 |
| `public/icons/` | 3 | PWA icons |

---

## 핵심 모듈

### Bootstrap / Runtime

| 파일 | 라인 | 역할 |
| --- | ---: | --- |
| `js/main.ts` | 612L | 앱 부트스트랩. 아이콘/프로바이더 아이콘 hydrate, i18n 초기화, CLI registry 로드, SSE event-channel + WS fallback 연결, 드래그앤드롭, auto-resize, commands/settings/employees/heartbeat/memory/app name/avatar/sidebar/theme/gesture 바인딩, production에서 SW 등록 |
| `js/state.ts` | 105L | 공유 상태 저장소. WS fallback, agent busy, attached files, heartbeat jobs/errors, CLI status cache, recording, `currentAgentDiv`, `currentProcessBlock` |
| `js/constants.ts` | 279L | CLI registry 동적 로딩, provider/model 매핑, CLI 메타 데이터 |
| `js/event-channel.ts` | 144L | `GET /api/events` SSE primary channel, Last-Event-ID replay, `replay_gap`, reconnect/backoff, legacy WS fallback handoff |
| `js/api.ts` | — | `api`, `apiJson`, `apiFire` fetch 래퍼 |
| `js/locale.ts` | — | localStorage 기반 locale 동기화 |
| `js/icons.ts` | 278L | Lucide 기반 중앙 아이콘 레지스트리 + emoji compatibility. `ICONS.robot`/`ICONS.tool` 등 ProcessBlock summary와 row icon에 재사용 |
| `js/provider-icons.ts` | 117L | provider SVG raw import + hydrate helper + label lookup. `codex-app` alias는 OpenAI icon을 녹색 color variant로 표시. kiro-code는 `kiro.svg`/`kiro-color.svg` 사용 |
| `js/uuid.ts` | — | virtual scroll와 live append가 공유하는 DOM-safe id 생성기 |
| `js/preview-parent-origin.ts` | — | `postPreviewInvalidate(topics, reason)` + `postPreviewOpenDoc(path)` bridge |

### Rendering / UI

| 파일 | 라인 | 역할 |
| --- | ---: | --- |
| `js/render.ts` | 18L | render public API façade |
| `js/render/markdown.ts` | — | marked pipeline, CJK punctuation fix, math/SVG shielding, sanitize/unshield, post-render scheduling |
| `js/render/sanitize.ts` | — | DOMPurify 기반 HTML/SVG sanitizer |
| `js/render/mermaid.ts` | — | lazy Mermaid load, queued render, observer, rerender, prewarm, unmount release |
| `js/render/mermaid-preprocess.ts` | — | Mermaid code fence preprocessing |
| `js/render/svg-actions.ts` | — | inline SVG block render, diagram copy/save/zoom actions |
| `js/render/highlight.ts` | — | highlight.js language registration, code block highlight |
| `js/render/file-links.ts` | — | local absolute path linkification, `.md` → `postPreviewOpenDoc()` 분기, external web-link `_blank` targeting |
| `js/render/post-render.ts` | — | Mermaid render, rehighlight, zoom binding, elicitation/search-results/link-preview hydration, file-path linkify를 100ms debounce로 coalesce |
| `js/render/code-copy.ts` | — | code block copy button |
| `js/render/html.ts` | — | HTML rendering helpers |
| `js/render/math.ts` | — | KaTeX math rendering |
| `js/render/notes-vault-path.ts` | — | notes vault path resolution |
| `js/render/delegations.ts` | — | render delegation registry |
| `js/render/search-results.ts` | — | `search-results` fenced JSON placeholder hydration. Final-render only; malformed specs fail closed, unsafe URLs are dropped, and results render as compact native cards. |
| `js/render/link-preview.ts` | — | External URL link preview lazy hydration. Skips internal/private/media links, fetches `/api/link-preview`, renders proxied images through `/api/link-preview/image`, caps concurrent preview fetches, and renders compact cards with favicon/site/URL metadata on the first line plus clamped title/description text. |
| `js/render/compose-block.ts` | — | `compose-block` fenced JSON placeholder hydration. Renders editable draft cards with variants, copy/open actions, final-render-only activation, and malformed-spec fail-closed errors. |
| `js/render/diff-viewer.ts` | — | Unified diff native renderer. Supports explicit `diff` fences and no-language unified diff auto-detect, escapes all content, caps large diffs, and keeps streaming code blocks inert. |
| `js/render/dataframe.ts` | — | `dataframe` fenced JSON placeholder hydration. Renders searchable/sortable/paginated read-only tables with cell copy, row/column caps, final-render-only activation, and malformed-spec fail-closed errors. |
| `js/render/chart-json.ts` | — | `chart-json` fenced JSON placeholder hydration. Renders dependency-free SVG bar/line/pie cards with legend swatches, data caps, final-render-only activation, and malformed-spec fail-closed errors. |
| `js/features/elicitation.ts` | — | `elicitation` / `choice-buttons` structured question placeholder hydration. Supports sequential wizard answers, skip/direct input, auto-injection, persistent compact completed-state rendering, and 21 Advanced `visibleWhen` prior-answer branching. Final-render oriented; malformed final specs fail closed with user-safe error + console diagnostic, and incomplete fences stay inert. |
| `src/shared/structured-fence.ts` | — | shared syntax-light scanner for `elicitation` / `choice-buttons` / `search-results` / `compose-block` / `dataframe` / `chart-json` fenced block completeness; used by frontend render guards and server lifecycle diagnostics. |
| `js/ui.ts` | 441L | 메시지 렌더링, skeleton/empty state, virtual scroll 연동, ProcessBlock 오케스트레이션, copy button, avatar markup 주입, message finalization, `scrollIntent` 기반 bottom-follow/restore policy |
| `js/ws.ts` | 877L | SSE/WS 공용 메시지 dispatcher + legacy WebSocket fallback. agent status, queue update, `agent_tool`→typed ProcessStep, agent output/done, orchestration state, interview panel, Telegram/Discord new message, reconnect snapshot, 10초 reload dedup, 8초 disconnect-toast grace, reconnect 후 bottom anchor reconciliation |
| `js/streaming-render.ts` | — | 스트리밍 텍스트 렌더러 |
| `js/virtual-scroll-bootstrap.ts` | — | virtual scroll 초기 hydrate/measure/bootstrap 오케스트레이터 |
| `js/virtual-scroll.ts` | 596L | TanStack virtualizer 기반 DOM 풀링, mounted node 재사용, post-render hook 실행, Mermaid observer release, scroll anchor preservation |
| `js/sanitizer.ts` | — | DOMPurify singleton + SVG/HTML attribute hook boundary |
| `js/cjk-fix.ts` | — | CJK 줄바꿈/구두점 보정 |
| `js/mermaid-loader.ts` | — | lazy Mermaid dynamic import |

### Diagram Pipeline

| 파일 | 역할 |
| --- | --- |
| `js/diagram/types.ts` | SVG block 추출, code-fence shielding/unshielding |
| `js/diagram/iframe-renderer.ts` | sandboxed iframe widget renderer, CSP/importmap/bridge script, copy/save 버튼, theme sync |
| `js/diagram/widget-validator.ts` | diagram-html 검증. 위험 패턴 차단 + CDN allowlist 검사 |

### Feature Modules

| 파일 | 라인 | 역할 |
| --- | ---: | --- |
| `features/avatar.ts` | — | agent/user avatar emoji 저장 + image upload/reset |
| `features/appname.ts` | — | sidebar agent name localStorage 저장 |
| `features/attention-badge.ts` | — | window focus/visibility 기반 unread/attention badge |
| `features/chat.ts` | 587L | send, slash command dispatch, unknown-command recovery, multi-file attachment, stop-mode, clear chat, auto-resize, voice send |
| `features/chat-messages.ts` | — | message DOM append/finalization helpers |
| `features/chat-scroll.ts` | — | bottom-follow/scroll intent helpers and initial settle |
| `features/chat-search.ts` | 226L | in-chat message search UI |
| `features/media-lightbox.ts` | — | 업로드 이미지/비디오 인라인 렌더링 + 라이트박스 |
| `features/copy-text.ts` | 39L | clipboard copy utility |
| `features/employees.ts` | — | employee CRUD + CLI/model/role 조정 |
| `features/gesture.ts` | — | 모바일 edge swipe sidebar toggle |
| `features/heartbeat.ts` | — | heartbeat job editor, cron/every + timezone validation |
| `features/help-content.ts` | — | help dialog topic content registry |
| `features/help-dialog.ts` | — | help trigger binding + modal rendering |
| `features/i18n.ts` | — | 프론트엔드 번역 bootstrap + `t()` |
| `features/idb-cache.ts` | — | IndexedDB conversation cache — scope-based, incremental upsert |
| `features/elicitation-state.ts` | — | `elicitation` / `choice-buttons` 완료 상태 keying, localStorage persistence, structured-response history backfill, shared spec normalization/hash |
| `features/memory.ts` | — | basic memory + advanced memory modal/indexing UI |
| `features/message-actions.ts` | — | message action button delegation |
| `features/message-history.ts` | — | history loading and reconnect restore flow |
| `features/message-item-html.ts` | — | message item HTML serialization helper |
| `features/orchestrate-scope.ts` | — | PABCD/orchestration scope display helper |
| `features/pending-queue.ts` | — | queued prompt overlay / pending queue 렌더 |
| `features/preview-shortcut-bridge.ts` | 44L | preview iframe shortcut message bridge |
| `features/process-block.ts` | 563L | collapsible ProcessBlock UI. `tool`/`thinking`/`search`/`subagent` step type, type별 summary, trusted icon 렌더링, expandable detail row |
| `features/process-block-dom.ts` | 175L | ProcessBlock DOM ownership, normalization, row replacement helpers |
| `features/process-log-adapter.ts` | — | persisted tool log to ProcessStep adapter |
| `features/process-step-match.ts` | — | ProcessStep matching helper |
| `features/project-git-status.ts` | 73L | legacy Web UI header의 project git summary badge. `/api/project/git-summary`를 읽어 `/ ⑂ branch *tracked ?untracked` compact label로 표시하고 narrow viewport에서는 숨김 |
| `features/settings.ts` | — | barrel re-export |
| `features/settings-channel.ts` | — | active channel + fallback order |
| `features/settings-cli-status.ts` | 482L | CLI availability/quota/status, kiro-code quota, generic auth/status badge |
| `features/settings-cli-status-render.ts` | 161L | CLI status row rendering helpers |
| `features/settings-core.ts` | 644L | settings load/update, per-CLI model/effort, locale sync, `postPreviewInvalidate` on active CLI change, projectDirs 변경 시 header git summary refresh |
| `features/settings-discord.ts` | — | Discord settings save/load/toggles |
| `features/settings-mcp.ts` | 561L | MCP server list/sync/install + registry browse/install (`/api/mcp/registry`) |
| `features/settings-stt.ts` | — | STT engine/provider fields |
| `features/settings-telegram.ts` | — | Telegram settings save/load/toggles |
| `features/settings-templates.ts` | — | prompt/template tree + editor + dev mode |
| `features/settings-types.ts` | — | shared settings interfaces |
| `features/sidebar.ts` | — | responsive collapse/expand, narrow overlay behavior |
| `features/skills.ts` | — | skill load/filter/toggle |
| `features/slash-commands.ts` | — | web slash command dropdown + workflow metadata chips |
| `features/theme.ts` | — | dark/light theme toggle, hljs theme swap, Mermaid/iframe refresh |
| `features/tool-ui.ts` | — | legacy finalized tool group + live activity helper |
| `features/trace-drawer.ts` | — | trace drawer open/close/render controls |
| `features/transport-status-row.ts` | 94L | transport status row rendering |
| `features/ui-status.ts` | — | compact UI status helper |
| `features/voice-recorder.ts` | — | MediaRecorder wrapper, MIME detection, pending/error UI, preview STT lifecycle |
| `features/workflow-event-adapter.ts` | 77L | workflow event → UI adapter |

### Settings Split

```text
settings.ts (barrel)
├─ settings-core.ts
├─ settings-telegram.ts
├─ settings-discord.ts
├─ settings-channel.ts
├─ settings-mcp.ts
├─ settings-cli-status.ts
├─ settings-cli-status-render.ts
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
| `css/chat.css` | chat area, message layout, input bar, attachments, voice button, virtual scroll container, slash command workflow chips, unknown-command recovery block, `.file-path-link` open states |
| `css/chat-search.css` | in-chat search overlay styling |
| `css/orc-state.css` | PABCD roadmap, shark runner, orc glow, state badge, interview panel (known/unknown 트래커, dimension bars, budget panel) |
| `css/sidebar.css` | left/right sidebar, collapse behavior, status / CLI / app name sections |
| `css/modals.css` | prompt/template/heartbeat/memory modal shells + form controls |
| `css/markdown.css` | markdown rendering, code block, copy button, tables, mermaid/KaTeX styles |
| `css/tool-ui.css` | tool call group, live activity, ProcessBlock summary/row/detail, subagent badge, row icon column |
| `css/diagram.css` | diagram container, widget iframe, overlay, zoom/copy/save buttons, semantic inline SVG label/connector color ramps |
| `css/trace-drawer.css` | trace drawer panel and event list styling |
| `css/workflow-cockpit.css` | workflow cockpit panel styling |

---

## Manager Dashboard — `public/manager/`

`public/manager/`는 메인 채팅 UI와 별개의 React 19 앱이다. `vite.config.ts`의 `manager` entry가 `public/manager/index.html`을 빌드한다.

### Manager preview memory note

2026-06-14 점검 기준, Chrome에서 manager Web UI를 열었을 때 1GB 근처까지 올라갔다가 약 10분 뒤 300MB대 근처로 안정화되는 패턴은 `jaw dashboard serve` manager 서버 누수보다 preview iframe의 cold-load peak로 해석한다. 실제 관찰에서는 manager 서버 `dist/src/manager/server.js` RSS가 약 170~220MB 수준이었고, 큰 RSS는 Chrome renderer와 각 `jaw serve` worker(`dist/server.js`) 쪽에 있었다.

원인 경로:

- `manager/src/InstancePreview.tsx`는 선택된 instance의 일반 Web UI를 iframe으로 mount한다.
- `manager/src/preview.ts`는 dedicated preview origin 또는 legacy `/i/{port}/` proxy URL을 만든다.
- iframe 안의 일반 Web UI는 `js/features/message-history.ts`의 `BOOT_MESSAGE_WINDOW = 3000`에 따라 `/api/messages?limit=3000` 최근 메시지 창을 boot fetch한다.
- 2026-06-14 실측에서 선택 instance `:3457`의 `/api/messages?limit=3000` payload는 3000 messages / 약 23.4MB JSON, full `/api/messages`는 5781 messages / 약 45.8MB JSON이었다.
- 이 payload는 normalize 결과, virtual scroll items, raw markdown, rendered HTML, structured renderer hydration, widget iframe, IndexedDB cache 등으로 브라우저 힙에서 여러 배로 증폭될 수 있다.

한 달 전 baseline(`7262770d4ea0e65b7fdb2e9eff54c64995e4f798`)은 `/api/messages` full history를 직접 로드했으므로 현재 코드가 더 큰 payload를 요청하게 바뀐 것은 아니다. 현재 코드는 이미 3000-message boot window로 제한되어 있다. 다만 그 사이 실제 chat DB가 커졌고, `search-results` / `link-preview` / `compose-block` / `dataframe` / `chart-json` 같은 structured renderer와 manager preview bridge 기능이 늘어 cold-load 피크가 더 잘 보일 수 있다.

패치가 필요하면 일반 Web UI의 3000-window를 무조건 줄이기보다 manager preview 전용 저메모리 모드를 우선 고려한다: preview URL에 `jawPreview=1` 같은 플래그를 붙이고, preview iframe 안에서는 boot window를 800~1000 수준으로 낮추거나 IndexedDB history cache / structured hydration을 더 lazy하게 만든다. 안정화 후 RSS가 내려가는 경우는 지속 누수로 분류하지 않는다.

| 파일/폴더 | 역할 |
| --- | --- |
| `manager/src/main.tsx` | `react-dom/client` `createRoot()`로 `App` 렌더 |
| `manager/src/App.tsx` | 475L — InstanceRegistry-backed scan/filter/select/lifecycle + dashboard section 상태 orchestration |
| `manager/src/AppChrome.tsx` | App chrome shell (sidebar rail + workspace layout) |
| `manager/src/SidebarRailRouter.tsx` | 323L — sidebar rail routing to workspace panels + Electron drop routing to FolderPanel/DocPanel |
| `manager/src/InstancePreview.tsx` | 303L — preview iframe mount/theme sync + STT shortcut bridge + sandbox popup escape + `jaw-preview-open-doc` + preview dropped-file metadata 수신 |
| `manager/src/panels/` | desktop panel infra: `PanelResizer`, `PanelLayoutProvider`, `RightSidebar`, `BottomPanel`, `BottomPanelTabBar`, `desktop-bridge`, `panel-capabilities`, `panel-shortcut-bus` |
| `manager/src/hooks/useElectronDroppedPaths.ts` | 89L — Electron-only OS file/folder drop resolver; Manager drops route to right panel, preview drops preserve iframe chip passthrough |
| `manager/src/doc-panel/` | `DocPanel.tsx` — dropped file / `.md` 절대경로를 우측 사이드바에 markdown preview로 렌더(Electron only) |
| `manager/src/folder-panel/` | Electron desktop Workspace Explorer; starts empty until explicit Open Folder/picked/dropped/worktree root, keeps that root independent from projectDirs/terminal/preview state, supports native file/folder move/copy/reveal plus minimal new/rename mutations, coalesces manual/watch/move/mutation/git-operation visible-tree refresh with large-tree branch budgeting/status, decorates rows with read-only Git status, exposes a compact existing-worktree selector, and gates worktree add/remove/prune behind preview + explicit confirmation with bounded result history and retry-with-confirmation |
| `manager/src/terminal/` | Electron desktop terminal panel |
| `manager/src/browser-panel/` | Electron desktop Browser panel (Google default, URL/search normalization) |
| `manager/src/diff-panel/` | Electron desktop Git Diff panel (server-backed via selected-instance `/api/dashboard/git/*` diff routes) |
| `manager/src/settings/` | settings pages/components/field renderers, `pages/Mcp.tsx` (MCP server cards + registry), Model defaults Pi profile popup |
| `manager/src/api.ts` | Dashboard API wrapper + manager event/diff surfaces |
| `manager/src/components/` | `ManagerShell`, `WorkspaceLayout`, `Instance*`, `Command*`, `ActivityDock`, `MobileNav`, `DesktopPanelControls` 등 |
| `manager/src/dashboard-board/` | Kanban board UI (backlog/ready/active/review/done lanes) |
| `manager/src/dashboard-schedule/` | schedule/heartbeat dashboard UI |
| `manager/src/dashboard-reminders/` | reminders matrix/sidebar/workspace UI, drag/drop, detail popover |
| `manager/src/dashboard-settings/` | Developer tools settings (diff defaults, embedding) |

### Manager Settings — Pi Runtime

| 파일 | 역할 |
| --- | --- |
| `manager/src/settings/pages/ModelProvider.tsx` | Pi를 Model defaults에서 AI-E보다 먼저 렌더하고 `settings.pi` draft를 `PerCliRow`로 전달 |
| `manager/src/settings/pages/components/PerCliRow.tsx` | `cli === "pi"` branch: Provider dropdown, discovered-model SelectField, Effort, Settings button |
| `manager/src/settings/pages/components/PiProfileDialog.tsx` | mode(`basic`/`openai`/`anthropic`/`vertex`) + endpoint/model/API key 등록 popup; `/api/pi/profiles/register` 호출 |
| `manager/src/settings/pages/components/pi-profile.ts` | Pi profile/model option pure helper |

- Pi model field는 발견된 모델이 있으면 `SelectField`를 사용하고, 목록이 비어 있을 때만 free-text `TextField`로 fallback한다.
- 등록 성공 시 `settings.pi.profiles`, `settings.pi.discoveredModels`, `perCli.pi.provider`, `perCli.pi.model` draft가 함께 갱신되어 Pi model dropdown에 새 모델이 바로 나타난다.
| `manager/src/jaw-ceo/` | Jaw CEO console panels, orchestration-control actions, voice, virtual timeline |
| `manager/src/goal-status/` `manager/src/background-tasks/` `manager/src/workers/` | Code mode runtime-observability monitors for goal/PABCD, background tasks, web-ai bgtask bridges, and worker progress |
| `manager/src/notes/` | markdown notes, search sidebar, WYSIWYG editing, wikilinks, graph view |
| `manager/src/hooks/` | dashboard registry/view persistence/instance message events hooks |
| `manager/src/sync/` | dashboard sync helpers (invalidation bus, iframe/visibility bridge) |
| `manager/src/help/` | help drawer + topic content |
| `manager/src/clipboard/` | copy-text utility |
| `manager/src/lib/` | shared utilities (preview-prefs, use-hidden-unload) |

Manager 서버는 `jaw dashboard serve`가 실행하는 `src/manager/server.ts`이며 기본 port는 `24576`. React manager app은 `/api/manager/events`, `/api/dashboard/instances`, `/i/:port/api/messages/latest` 계열 polling으로 상태를 읽는다. Worker live bridge는 browser가 직접 EventSource를 여는 구조가 아니라 manager server의 `src/manager/worker-events.ts` + `src/manager/worker-sse-client.ts`가 각 worker instance `GET /api/events`를 server-side 구독하고 latest-message cache를 갱신하는 구조다. Jaw CEO right panel은 completion/watch/voice/orchestration control을 소유하고, Code mode monitor panels는 `/api/manager/runtime-status`, `/api/bgtask`, `/api/orchestrate/worker-progress` 기반 runtime observability를 소유한다. web-ai long task는 BrowserPanel이나 Code transcript가 아니라 `preset: "web-ai"` background task로 등록되며, monitor retry도 native web-ai session id를 보존한 preset 재등록을 사용한다. Background task monitor는 terminal completion, cancellation/orphaning, and notification handoff 모두를 `bgtask_update` + `GET /api/bgtask` hydration으로 반영한다.

---

## ProcessBlock / Subagent Rendering

tool history의 canonical UI는 `features/process-block.ts`다. `ui.ts`는 live channel event(SSE primary / legacy WS fallback), persisted `tool_log`, IndexedDB fallback, virtual-scroll history 모두를 `ToolLogEntry[]` → `ProcessStep[]` → ProcessBlock HTML 흐름으로 맞춘다.

| 관심사 | 현재 구현 |
| --- | --- |
| 타입 보존 | `ws.ts`는 `msg.toolType === 'subagent'`를 `ProcessStep.type = 'subagent'`로 넘기고, unknown type만 `tool`로 떨어진다 |
| Summary split | type별로 `Thinking`, `Search`, `Subagent`, `Tool`을 따로 count |
| row layout | `.process-step-toggle`은 `auto 16px auto minmax(0, 1fr) auto` grid |
| rawIcon / SVG policy | `renderTrustedIcon()`은 `<svg...`로 시작하는 값만 SVG로 삽입, 나머지는 escape |
| running → done merge | `stepRef` 기반 매칭 우선, 없으면 같은 label의 running row 매칭 |
| done-only fallback blocking | `stepRef`가 있는 done/error 이벤트는 legacy fallback을 타지 않음 |
| repeated done-only dedup | 같은 `stepRef`의 done/error row가 이미 있으면 `replaceStep()` |
| single-owner invariant | `.agent-body > .process-block` 하나만 허용, `normalizeAgentToolBlocks()`가 정리 |
| layout mutation anchor | `window.__jawProcessBlockLayoutMutation(anchor, mutate)` bridge로 virtual-scroll remeasure + row-top anchor 보존 |
| lazy history render | virtual-scroll history item은 mounted lazy render 시점에 ProcessBlock detail HTML 생성 |
| mermaid cleanup | unmount/deactivate 전 `releaseMermaidNodes()` 호출 |

---

## PWA / Assets

| 자산 | 현재 구현 |
| --- | --- |
| `manifest.json` | `standalone`, `theme_color: #22d3ee`, 192/512/maskable icons |
| `sw.js` | navigation network-first, `/dist/assets/*` cache-first, 그 외 stale-while-revalidate |
| `icons/` | `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` |
| `assets/providers/` | `antigravity(-color)`, `claude(-color)`, `copilot(-color)`, `cursor(-color)`, `gemini(-color)`, `grok(-color)`, `kiro(-color)`, `openai`, `opencode`, `discord`, `telegram` |
| `assets/fonts/` | `GeistVF.woff2`, `JetBrainsMono-Variable.woff2` |
| `locales/` | `ko.json`, `en.json`, `ja.json`, `zh.json` |

---

## 현재 런타임 흐름

| 단계 | 구현 사실 |
| --- | --- |
| 초기화 | `hydrateIcons()` → `hydrateProviderIcons()` → `initI18n()` → `loadCliRegistry()` → `connect()` → `initAvatar()` + pending/help/attention 초기화 |
| 입력 | slash command dropdown, file attachment, drag/drop, auto-resize, voice record/cancel, STT mic pending state |
| 전송 | 일반 메시지는 `/api/message`, slash command는 `/api/command`, stop 버튼은 `/api/stop` |
| 렌더링 | `render.ts` façade → `public/js/render/*` 모듈이 markdown/KaTeX/Mermaid/code copy/diagram widget/file-path click-to-open/external web-link new-tab targeting/post-render 담당 |
| 오프라인 | `idb-cache.ts`가 메시지 히스토리를 IndexedDB에 보관 — scope별 캐시, 실시간 upsert |
| Event channel | `GET /api/events` SSE primary channel handles `agent_tool`→typed ProcessBlock step, `agent_output`→streaming renderer, `agent_done`→finalization; `ws.ts` is the shared dispatcher and legacy WebSocket fallback for pre-X-01 servers. Transient SSE drops are quiet for 8 seconds before the UI posts a disconnected message. |
| 상태 | `agent_status`, `queue_update`, `orc_state`, `session_reset`, `clear`, Telegram/Discord `new_message` |
| 반응형 | sidebar collapse/expand, mobile edge swipe, theme switch, PABCD roadmap, voice shortcut(`Ctrl/Cmd+Shift+Space`, `Alt/Option+M`) |
| Manager | 별도 React 앱이 dashboard API polling으로 Jaw 인스턴스 scan/preview/lifecycle, notes, board, reminders, schedule, CEO console을 관리하고, manager server가 worker SSE bridge/cache를 담당 |

---

## Runtime Hardening Invariants

| 영역 | invariant |
| --- | --- |
| Web UI runtime tests | `tests/unit/web-ui-test-dom.ts`가 jsdom globals를 먼저 설치 |
| ProcessBlock DOM recovery | `.process-step` row는 `data-step-id`, `data-type`, `data-status`, `data-step-ref`, `data-start-time` 보존 |
| Restore bottom-follow intent | `scrollIntent = unknown/following/pinnedAway` 기준 guarded reconciliation |
| Build output guard | `npm run check:frontend-build-output`가 eager Mermaid reference 차단 |
| Tool-log memory cap | Server-side `sanitizeToolLog*()` caps before ProcessBlock/Manager hydration |

---

## UI 모달/팝업 규약

### 메인 Web UI

모달/팝업은 **`document.body`에 동적 생성**. `help-dialog.ts` 참조:
1. overlay → `className = 'modal-overlay'` → `document.body.append(overlay)`
2. box → `role="dialog"` + `aria-modal="true"`
3. 열기: `.open` 클래스 추가
4. 닫기: `.open` 제거 + Esc 키
5. CSS: `public/css/modals.css`

### Manager Dashboard

React 컴포넌트에서는 `role="dialog"` + `aria-modal` 패턴.

### 두 UI 간 기능 동기화

백엔드 API는 동일, 프론트엔드만 다름 (Vanilla JS vs React). 기능 추가 시 양쪽 모두 구현 필요.
