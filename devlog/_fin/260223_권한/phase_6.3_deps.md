# (fin) Phase 6.3 — 스킬 의존성 분석

> Phase 9 `auto_deps` 참고 형식

## 개요

active 스킬은 `npm install` 시 의존성을 자동 설치.
ref 스킬은 SKILL.md에 설치 안내만 기재.

---

## Active 스킬 (12개) 의존성

### ✅ Shell Only (의존성 없음)

| 스킬                | 동작 방식                               |
| ------------------- | --------------------------------------- |
| yeet                | `gh` CLI (Phase 9에서 이미 doctor 체크) |
| gh-address-comments | `gh` CLI                                |
| gh-fix-ci           | `gh` CLI + 번들 Python                  |
| openai-docs         | Codex MCP 내장                          |

### 📦 외부 의존성 필요

| 스킬        | 의존성                       | 설치          | Phase 9 커버? |
| ----------- | ---------------------------- | ------------- | ------------- |
| screenshot  | `python3` + macOS 권한       | 번들 스크립트 | ✅ uv로 커버   |
| playwright  | `npx playwright-core`        | npm 내장      | ✅ Phase 9     |
| imagegen    | `python3` + `OPENAI_API_KEY` | uv pip        | ✅ Phase 9     |
| doc         | `python-docx` + Poppler      | uv pip        | ✅ Phase 9     |
| pdf         | `reportlab` + `pdfplumber`   | uv pip        | ✅ Phase 9     |
| spreadsheet | `openpyxl` + `pandas`        | uv pip        | ✅ Phase 9     |
| browser     | `playwright-core` + Chrome   | npm + 수동    | ✅ Phase 9     |
| notion      | `curl`                       | 내장          | ✅ 없음        |

> **결론: Active 의존성은 Phase 9에서 이미 자동 설치 구현 완료.**
> uv (Python 스킬) + playwright-core (browser) + gh (git 스킬) 3개로 전부 커버.

---

## Ref 스킬 의존성 매핑

ref 스킬은 SKILL.md에 설치 방법 기재만 하면 됨. (AI가 안내)

### 의존성 없음 (curl/shell만)

| 스킬                   | 방식           |
| ---------------------- | -------------- |
| weather                | `curl wttr.in` |
| notion (ref)           | `curl` + API키 |
| cloudflare-deploy      | `wrangler` CLI |
| netlify-deploy         | `netlify` CLI  |
| vercel-deploy          | `vercel` CLI   |
| linear                 | `linear` CLI   |
| figma-implement-design | Codex MCP      |

### API 키 필요

| 스킬            | 키                                | 설치 안내 in SKILL.md? |
| --------------- | --------------------------------- | ---------------------- |
| notion-×4       | `NOTION_API_KEY` + Notion MCP     | ✅ 있음 (codex mcp add) |
| trello          | `TRELLO_API_KEY` + `TRELLO_TOKEN` | ✅ 있음                 |
| goplaces        | `GOOGLE_PLACES_API_KEY`           | ✅ 있음                 |
| nano-banana-pro | `GEMINI_API_KEY` + `uv`           | ✅ 있음                 |
| sora            | `OPENAI_API_KEY` + `python3`      | ✅ 있음                 |
| speech          | `OPENAI_API_KEY` + `python3`      | ✅ 있음                 |
| transcribe      | `OPENAI_API_KEY`                  | ✅ 있음                 |
| gh-issues       | `GH_TOKEN` + `gh`                 | ✅ 있음                 |
| 1password       | `op` CLI                          | ✅ 있음                 |

### 외부 CLI 바이너리 필요

| 스킬            | 바이너리         | 설치 명령                     | SKILL.md에 기재? |
| --------------- | ---------------- | ----------------------------- | ---------------- |
| himalaya        | `himalaya`       | `brew install himalaya`       | ✅                |
| gog             | `gog`            | Go install                    | ✅                |
| xurl            | `xurl`           | `brew install xurl`           | ✅                |
| github          | `gh`             | `brew install gh`             | ✅                |
| tmux            | `tmux`           | `brew install tmux`           | ✅                |
| obsidian        | `obsidian-cli`   | `brew install obsidian-cli`   | ✅                |
| openhue         | `openhue`        | `brew install openhue`        | ✅                |
| spotify-player  | `spotify_player` | `brew install spotify_player` | ✅                |
| video-frames    | `ffmpeg`         | `brew install ffmpeg`         | ✅                |
| summarize       | `summarize`      | 별도 설치                     | ✅                |
| things-mac      | `things`         | `go install`                  | ✅                |
| nano-pdf        | `nano-pdf`       | Python                        | ✅                |
| apple-notes     | AppleScript      | 없음 (macOS 내장)             | ✅                |
| apple-reminders | AppleScript      | 없음 (macOS 내장)             | ✅                |

### Python 번들 스크립트 필요

| 스킬             | 의존성               | uv로 자동?      |
| ---------------- | -------------------- | --------------- |
| atlas            | `python3` + 번들 .py | Phase 9 uv 커버 |
| jupyter-notebook | `python3` + 번들 .py | Phase 9 uv 커버 |
| sentry           | `python3` + 번들 .py | Phase 9 uv 커버 |
| skill-creator    | `python3` + 번들 .py | Phase 9 uv 커버 |

---

## 결론

| 구분                | 의존성 처리                                   |
| ------------------- | --------------------------------------------- |
| **Active + Python** | Phase 9 `uv` 자동 설치로 커버 ✅               |
| **Active + Node**   | Phase 9 `playwright-core` 자동 설치 ✅         |
| **Active + gh**     | Phase 9 `doctor` 안내 ✅                       |
| **Active + curl**   | 의존성 없음 ✅                                 |
| **Ref + 외부 CLI**  | SKILL.md에 `brew install` 등 기재 → AI가 안내 |
| **Ref + API 키**    | SKILL.md에 키 발급 방법 기재 → AI가 안내      |
| **Ref + Python**    | Phase 9 uv가 이미 있으면 자동 커버            |

> **추가 작업 불필요.** Phase 9가 이미 active 의존성 자동 설치를 구현했고,
> ref 스킬은 SKILL.md에 설치 안내가 이미 포함되어 있음.

## 체크리스트

- [x] Active 스킬 의존성 분석 — Phase 9에서 전부 커버 확인
- [x] Ref 스킬 의존성 분석 — SKILL.md에 설치 안내 포함 확인
- [ ] registry.json에 `requires` 필드 보강 (GUI에서 의존성 상태 표시)
