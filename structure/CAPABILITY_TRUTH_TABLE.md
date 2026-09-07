---
created: 2026-05-05
phase: 22
tags: [cli-jaw, truth-table, release-claims, agbrowse-mirror]
aliases: [cli-jaw capability truth table]
---

# cli-jaw Capability Truth Table

Single source of truth for browser / web-AI capability status in `cli-jaw`,
expressed against the `agbrowse` source implementation. Phase 22 introduces
this table to lock parity claims. Update in the same commit as any capability
or release-claim change.

Status legend:

- `ready` — implementation, tests, and docs all agree in cli-jaw.
- `beta` — depends on live provider UI / accounts.
- `experimental` — opt-in, narrow scope, no production claim.
- `deferred` / `planned` — explicitly not implemented in cli-jaw; agbrowse may
  cover the surface independently.

`Mirror In cli-jaw` describes how cli-jaw consumes or re-exports the
capability.

| Capability | Status | Code Location | Tests | Mirror In cli-jaw |
| --- | --- | --- | --- | --- |
| Browser runtime cleanup / `doctor` | ready | `src/browser/runtime-diagnostics.ts`, `src/browser/connection.ts`, `src/routes/browser.ts` | `tests/unit/browser-connection.test.ts`, `tests/unit/browser-idle-autoclose.test.ts`, `tests/unit/browser-port.test.ts` | native cli-jaw surface; not via agbrowse |
| ChatGPT web-AI resolver | beta | `src/browser/web-ai/chatgpt.ts`, `src/browser/web-ai/chatgpt-composer.ts`, `src/browser/web-ai/session.ts` | `tests/unit/browser-web-ai-composer.test.ts`, `tests/unit/browser-web-ai-composer-resolved.test.ts`, `tests/unit/browser-web-ai-cli-contract.test.ts` | mirrored from agbrowse `web-ai/chatgpt.mjs` symbols |
| Gemini / Grok web-AI live adapters | beta | `src/browser/web-ai/gemini-live.ts`, `src/browser/web-ai/gemini-model.ts`, `src/browser/web-ai/grok-live.ts`, `src/browser/web-ai/grok-model.ts`, `bin/commands/browser-web-ai.ts` | live-provider/manual; CLI contract coverage is shared with `browser web-ai` | native `--vendor gemini\|grok` web-ai path; do not label `ready` without deterministic provider tests |
| ChatGPT code-mode zip generation/extraction | beta | `src/browser/web-ai/code-mode.ts`, `src/browser/web-ai/code-mode-prompt.ts`, `src/browser/web-ai/code-artifact.ts`, `src/browser/web-ai/code-dev-context.ts`, `src/routes/browser.ts`, `bin/commands/browser-web-ai.ts` | `tests/unit/browser-web-ai-code-*.test.ts`, `tests/unit/browser-web-ai-cli-contract.test.ts` | independent cli-jaw mirror of agbrowse code mode; auto-attaches GPT dev-agent context zip and requires `PLAN.md`/`00_plan.md` on new artifacts |
| Adaptive URL fetch (`browser fetch`) | experimental | `src/browser/adaptive-fetch/*` (32+ modules: `scheduler.ts`, `stage-types.ts`, `bm25-filter.ts`, `browser-runtime.ts`, `tls-fetch.ts`, `ytdlp-reader.ts`, `camoufox-session.ts`, `challenge-detector.ts`, `endpoint-resolvers.ts` 23 platform resolvers) | `tests/unit/browser-adaptive-fetch-*.test.ts`, `tests/integration/browser-fetch-command.test.ts` | P0 hardened mirror: typed stage scheduler, SSRF on all transports, overall-deadline + in-flight `AbortSignal` cancellation through browser/CDP, warm browser pool (max 3, 30s TTL), HTTP/HTTPS proxy chain, BM25 content filter, Camoufox stealth, yt-dlp metadata/transcript, Jina Reader default-on + 429 cooldown, TLS fingerprint via curl-impersonate — **not** generic search or CAPTCHA/login bypass |
| Action-intent / semantic target resolver (incl. `send.click`) | ready | `src/browser/web-ai/action-intent.ts`, `src/browser/web-ai/target-resolver.ts` | `tests/unit/browser-web-ai-target-resolver.test.ts` | direct mirror of agbrowse `web-ai/action-intent.mjs` + `target-resolver.mjs` |
| `answerArtifact` on completed answers | ready | `src/browser/web-ai/answer-artifact.ts`, `src/browser/web-ai/session.ts`, `src/browser/web-ai/index.ts` | `tests/unit/browser-web-ai-answer-artifact.test.ts` | direct mirror of `web-ai/answer-artifact.mjs` |
| `sourceAudit` (`--require-source-audit`, ratio/scope/date flags) | ready | `src/browser/web-ai/source-audit.ts`, `src/browser/web-ai/index.ts` (CLI), `src/routes/browser.ts` (HTTP) | `tests/unit/browser-web-ai-source-audit.test.ts`, `tests/unit/browser-web-ai-cli-contract.test.ts` | direct mirror of `web-ai/source-audit.mjs`; CLI + HTTP query flags exposed |
| MCP browser tools (`browser_snapshot`, `browser_click_ref`) | n/a (not exposed by cli-jaw) | n/a | n/a | cli-jaw does not register browser MCP tools; users invoke agbrowse MCP server directly |
| MCP planned tools (`browser_type_ref`, `browser_navigate`, ...) | deferred | n/a | n/a | tracked in agbrowse `DEFERRED_BROWSER_TOOLS` (structured metadata) + `structure/mcp_scope.md` decision record (G04). cli-jaw exposes zero browser MCP tools by design; `gate:mcp-scope-frozen` enforces. |
| External / remote CDP adapter | deferred (experimental) | n/a in cli-jaw | n/a | see `docs/EXTERNAL_CDP.md` (both repos) |
| Benchmark trajectory writer | planned | n/a in cli-jaw | n/a | cli-jaw consumes agbrowse trajectory bundles only; no native writer |
| Release gates (named) | ready | `scripts/release-gates.mjs`, package scripts `gate:*` | `tests/unit/release-gates.test.ts` (Phase 22) | mirror of agbrowse named gates with cli-jaw-specific checks; `gate:all` includes docs/parity freshness gates |
| Claim audit (`gate:no-cloud-claims`) | ready | `scripts/claim-audit.mjs`, `scripts/release-gates.mjs` (G10 mirror) | `tests/unit/scripts-claim-audit.test.ts`, `npm run gate:no-cloud-claims` | mirrors `agbrowse/web-ai/claim-audit.mjs`; scans cli-jaw READMEs + truth table |
| Observe actions API (`buildObserveActions`) | ready | `src/browser/web-ai/observe-actions.ts`, `scripts/release-gates.mjs` (G02 mirror) | `tests/unit/observe-actions.test.ts`, `npm run gate:observe-actions-fixtures` | mirrors `agbrowse/web-ai/observe-actions.mjs`; same ActionCandidate schema |
| Observation bundle (`buildObservationBundle`, ObservationBundleV1) | ready | `src/browser/web-ai/observation-bundle.ts`, `scripts/release-gates.mjs` (G06 mirror) | `tests/unit/observation-bundle.test.ts`, `npm run gate:observation-bundle-fixtures` | mirrors `agbrowse/web-ai/observation-bundle.mjs`; pure assembler, schema `observation-bundle-v1` |
| Action breadth catalog (`BROWSER_PRIMITIVES`, 22 primitives) | ready | `src/browser/web-ai/action-breadth.ts`, `scripts/release-gates.mjs` (G03 mirror) | `tests/unit/action-breadth.test.ts`, `npm run gate:browser-primitives-catalog` | mirrors `agbrowse/web-ai/action-breadth.mjs`; schema `browser-primitives-v1`; supports parity audits against agbrowse CLI |
| Action memory cache (`createActionMemory`, ActionMemoryV1) | experimental | `src/browser/web-ai/action-memory.ts`, `scripts/release-gates.mjs` (G07 mirror) | `tests/unit/action-memory.test.ts`, `npm run gate:action-memory-safe-replay` | mirrors `agbrowse/web-ai/action-memory.mjs`; pure store + signature-validated lookup (drift returns null). Not yet wired into resolver — cross-repo parity for the cache primitive only. |
| G09 model-adapter (provider API clients / hosted model routing) | deferred (frozen) | n/a — no API adapter code in cli-jaw. Mirrors `agbrowse` G09 freeze. | `npm run gate:model-adapter-frozen` (negative-parity scan) | cli-jaw must NOT contain provider SDK deps (`openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `@google/genai`, `ai`, `@ai-sdk/*`), `api-query`/`--api`/`--transport api` aliases, `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`/`MODEL_ADAPTER_*` env vars, or `src/browser/web-ai/model-adapter/*` paths. The web-ai skill in agbrowse is the adapter surface; cli-jaw mirrors only the deferred row. |
| G01 mirror — planner-contract types (PlannerObjective / CandidateActionV1 / PlannerResultV1) | experimental | `src/browser/web-ai/planner-contract.ts` | `tests/unit/planner-contract.test.ts` | Type-only mirror of agbrowse `web-ai/planner-contract.mjs` (schema frozen at `planner-result-v1`). cli-jaw does NOT mirror the runtime planner-loop — the loop stays first-party in agbrowse. cli-jaw exposes the contract so downstream tooling can typecheck `PlannerResultV1` payloads emitted by `agbrowse web-ai task-run`. |
| Strict TypeScript migration (P00–P20) | ready | repo-wide `tsconfig.json` | `npm run typecheck`, `tests/unit/strict-baseline.test.ts` | independent of agbrowse |

## Mirror Rules

- A `ready` claim in cli-jaw must reference the corresponding agbrowse source
  module (where applicable) and have a test file in `tests/unit/` or
  `tests/integration/`.
- New **browser / web-AI** capability ⇒ update both the table above and
  `agbrowse/structure/CAPABILITY_TRUTH_TABLE.md` in the same change set. This
  mirror rule covers the browser section only; the messaging matrix below is
  generated from cli-jaw source and never requires an agbrowse-side edit.
- The `gate:truth-table-fresh` release gate enforces a ≤7 day staleness or a
  matching code/tests checksum, and separately fails on messaging-matrix drift.

## Forbidden Claims

- No `ready` claim for hosted/cloud, external/remote CDP, stealth flows, or live-provider Gemini/Grok flows without deterministic tests.
- No CAPTCHA/login/paywall/stealth bypass claim for adaptive fetch. P0 adds typed scheduler + deadline/cancellation but still surfaces access boundaries instead of crossing them.
- Adaptive fetch is **not** generic web search — URL/search-result reader for known URLs only; browser escalation and third-party readers are opt-in with explicit boundaries.
- No leaderboard or competitor benchmark score (cli-jaw does not own the
  trajectory writer).
- No production MCP claim from cli-jaw — cli-jaw does not register browser MCP
  tools; agbrowse owns that surface.

## Cross-References

- agbrowse truth table: `agbrowse/structure/CAPABILITY_TRUTH_TABLE.md`
- External CDP deferral: [../docs/EXTERNAL_CDP.md](../docs/EXTERNAL_CDP.md)

## Messaging ChannelAdapter Matrix

아래 블록은 `scripts/generate-channel-capability-table.mts`가 소유합니다. 손으로
고치지 말고 `npm run docs:channel-capabilities`로 다시 생성하세요.

<!-- BEGIN GENERATED: messaging-channel-capabilities -->
<!-- 이 블록은 생성됩니다. 손으로 고치지 마세요. -->
<!-- 생성기: scripts/generate-channel-capability-table.mts · 소스: src/messaging/channel-capabilities.ts -->

> **생성된 블록입니다 — 직접 수정하지 마세요.** `src/messaging/channel-capabilities.ts`의
> 선언을 읽어 `npm run docs:channel-capabilities`가 다시 씁니다.
> 손으로 고친 내용은 `gate:truth-table-fresh`에서 drift로 실패합니다.

| Capability | telegram | discord | slack | 의미 |
| --- | --- | --- | --- | --- |
| `sendText` | ✅ | ✅ | ✅ | 텍스트 전송 |
| `editText` | ✅ | ❌ | ✅ | 전송된 메시지 수정 |
| `deleteMessage` | ✅ | ❌ | ✅ | 전송된 메시지 삭제 |
| `reaction` | ✅ | ✅ | ✅ | 리액션 부착 |
| `typing` | ✅ | ✅ | ❌ | 입력 중 표시 |
| `fileUpload` | ✅ | ✅ | ✅ | 파일 업로드 |
| `voice` | ✅ | ✅ | ✅ | 음성 파일 전달 (녹음 UI 아님) |
| `threads` | ✅ | ✅ | ✅ | 스레드 타겟팅 |
| `interactiveActions` | ✅ | ❌ | ❌ | 버튼 등 인터랙티브 액션 |
| `durableIngress` | ✅ | ✅ | ✅ | 프로세스 재시작 후에도 유지되는 inbound 중복 제거 |
| `replayableTransport` | ✅ | ✅ | ✅ | 미확인 프레임을 트랜스포트가 재전송 |
| `maxMessageChars` | `32,000` | `2,000` | `3,900` | 단일 메시지 문자 상한 (chunker 상수) |

출처와 검증 지점:

- 선언 (SoT): [`src/messaging/channel-capabilities.ts`](../src/messaging/channel-capabilities.ts)
- 어댑터 계약: [`src/messaging/channel-adapter.ts`](../src/messaging/channel-adapter.ts)
- conformance test: `tests/unit/channel-contract-conformance.test.ts` — 이 스위트 통과가 `true` 선언의 유일한 근거
- 생성기: [`scripts/generate-channel-capability-table.mts`](../scripts/generate-channel-capability-table.mts) (`--check`는 `gate:truth-table-fresh`가 실행)

`true`는 이 트리에서 오늘 호출 가능한 동작만을 뜻합니다. 벤더 SDK가 제공한다는
사실은 근거가 아닙니다 — conformance test가 통과할 때만 선언을 올립니다.
<!-- END GENERATED: messaging-channel-capabilities -->
