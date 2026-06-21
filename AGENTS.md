# cli-jaw

System-level AI agent with full computer control via CLI wrapping (pi, agy, ai-e, claude, claude-e, codex, codex-app, cursor, kiro-code, gemini, grok, opencode, copilot).

## Repository Structure

```
lidge-jun/cli-jaw              ← public (this repo)
├── skills_ref/  (submodule)   ← lidge-jun/cli-jaw-skills (public reference skills)
├── devlog/      (submodule)   ← lidge-jun/cli-jaw-internal (private)
└── .npmignore                 ← npm publish 시 submodules 제외
```

### Clone

```bash
# 코드만
git clone https://github.com/lidge-jun/cli-jaw.git

# 코드 + skills + devlog (private 권한 필요)
git clone --recursive https://github.com/lidge-jun/cli-jaw.git
```

### Submodule Update

서브모듈 수정 후 반드시 메인 레포에서도 ref 커밋:

```bash
cd devlog  # 또는 skills_ref
git add -A && git commit -m "update" && git push
cd ..
git add devlog && git commit -m "chore: update devlog ref" && git push
```

### devlog 접근

`devlog/` 는 private 레포입니다. 접근 필요 시 [Issue](https://github.com/lidge-jun/cli-jaw/issues)에서 collaborator 권한을 요청하세요.

### Kanban

프로젝트 보드: https://github.com/users/lidge-jun/projects/2/views/1

### Architecture Docs Sync

- `structure/` is the current architecture-doc hub; do not point new docs at `devlog/structure/`.
- Keep `README.md`, root `AGENTS.md`, root `CLAUDE.md`, and `structure/AGENTS.md` synchronized when command/API/orchestration surfaces change.
- Recent non-strict hotspots: explicit `/continue`, workflow helper slash commands (`/plan` as PABCD P compatibility guide, `/interview`, `/deliberate`, `/planaudit`, `/review` as projectDirs/recent-context repo review with no JAW_HOME fallback, optional user focus text, and current-conversation-first scope resolution backed by recent goal/chat + git history/diff/worktree evidence, gated `/goal`; `/goal plan` and `/goalplan` store user direction as `planHint` and require `/goal refine` before checkpoints; bounded automation is `/goal run ...`, not top-level `/autopilot`), Pi top-level `pi --mode rpc` runtime with isolated `PI_CODING_AGENT_DIR` profiles, Gemini `--skip-trust --approval-mode yolo`, AGY `-p` print-mode runtime, SSE-first `GET /api/events` event channel with WebSocket fallback, bounded tool-log sanitizer, worker progress query/watch, canonical `/api/channel/send`, heartbeat `every`/`cron` schedules, browser runtime diagnostics/session lifecycle, Electron Node sidecar packaging, private active `k-writing` routing for Korean promotional/content writing, and `npm run gate:all`.

### Korean Content Skill Routing

Korean promotional/content writing (홍보 쓰레드, 인스타 카드뉴스, 링크드인, 웹/블로그 게시물, 윤문)는 active `k-writing` skill이 소유한다. 임의 산문으로 바로 작성하지 말고 channel routing → mandatory pre-search → hook 3안 scoring → tone/module formatting → anti-AI-tell + 인간다움 checklist를 거친다. `k-thread-gen`은 retired label로만 언급하고 새 라우팅 이름으로 쓰지 않는다.

### Build & Deploy Contract (서버 코드 변경 시 필수)

**실행 중인 서버는 TS 소스가 아니라 컴파일된 `dist/`를 실행한다** (`jaw serve` → `dist/server.js`, CLI → `dist/bin/cli-jaw.js`). 소스만 커밋하고 빌드를 빼먹으면 서버를 재시작해도 변경이 반영되지 않는다 (260610 `/api/project/pick` 404 사고의 원인).

서버/CLI 코드(`server.ts`, `src/**`, `bin/**`)를 변경했다면:

```bash
npm run build           # tsc → dist/ atomic swap (prebuild: ensure:native 포함)
npm run build:frontend  # public/js·public/manager 변경 시 (→ public/dist)
```

- 변경 반영 단위 = **커밋 + 해당 빌드 + 서버 재시작** 3종 세트. 빌드 없이 "재시작하면 됩니다"라고 안내하지 말 것.
- 프론트엔드(`public/js/*.ts`, `public/manager/src/**`)는 `build:frontend`만으로 충분하며 서버 재시작 없이 브라우저 새로고침으로 반영된다 (`public/dist` 정적 서빙).
- 반영 여부 검증: `grep <new-symbol> dist/...` 또는 해당 엔드포인트 curl로 확인 후 안내.

### Line Count Format (`str_func.md`)

File tree の行数は **`(NNNL)`** 형식으로 기재. 두 가지 변형 허용:

```
├── server.js          ← 설명 (757L)           ← 단순 형식
├── chat.js            ← 설명 (3모드, ..., 843L) ← 다중 메타 형식
```

- 숫자 + `L` + `)` 또는 `,` 로 끝나야 detection 가능
- 검증: `bash structure/verify-counts.sh` (exit code = 불일치 수; 현재는 `str_func.md` 파일 트리의 모든 `(NNNL)` 파일 항목도 검사)
- 자동 수정: `bash structure/verify-counts.sh --fix`
- **파일 수정 후 반드시 verify-counts 실행해서 문서 동기화**

### Devlog Archive (`devlog/_fin/`)

- 완료된 phase 폴더는 `devlog/_fin/`으로 이동 (folder-per-phase, 단독 `.md` 금지)
- 계획/구현대기 문서는 `devlog/_plan/`으로 이동 (`_fin`에 두지 않음)
- `devlog/` 루트에는 진행 중인 폴더만 유지
- 후순위 작업은 `269999_` 접두사로 표시
- Reference bundles (skill packages, test fixtures)은 반드시 phase 폴더 안에 포함
- 전체 규칙: [`devlog/_fin/HYGIENE.md`](devlog/_fin/HYGIENE.md)
- 점검: `bash structure/audit-fin-status.sh`
- 자동 분리: `bash structure/audit-fin-status.sh --move-planning`

### Phase Document Frontmatter

```yaml
---
created: 2026-MM-DD
status: planning | active | blocked | done | deferred
tags: [cli-jaw, ...]
---
# (fin) Phase Title    ← 구현 완료 시 (fin) 접두사
```

- `status:` 필드 필수 — `planning`, `active`, `blocked`, `done`, `deferred` 중 택 1
- Legacy prose forms (`> Status:`, `**Status**:`) remain readable during migration,
  but new/updated phase docs must use YAML frontmatter.
- 구현 완료된 문서 제목에 `(fin)` 접두사 추가

### OfficeCLI (On-Demand)

OfficeCLI is NOT bundled with cli-jaw postinstall. It is installed on-demand when skills need L1/L2 features or HWP support.

- **Format support**: .docx, .xlsx, .pptx, .hwpx, .hwp (HWP via rhwp sidecars)
- **Install (forked, CJK + rhwp)**: `bash "$(npm root -g)/cli-jaw/scripts/install-officecli.sh"`
- **Install (upstream, vanilla)**: `bash "$(npm root -g)/cli-jaw/scripts/install-officecli.sh" --upstream`
- **Smoke test**: `officecli --version && officecli capabilities --json`
- **Binary priority**: `OFFICECLI_BIN` env → global `officecli` → not available
- **Fork**: `lidge-jun/OfficeCLI` (CJK-enhanced, rhwp sidecars) vs. `iOfficeAI/OfficeCLI` (vanilla)
- **Safety**: Never run parallel officecli processes on the same file

```bash
officecli create file.docx                                          # create blank
officecli view file.docx text                                       # view content
officecli add file.docx /body --type paragraph --prop text="..."    # add content
officecli set data.xlsx /Sheet1/A1 --prop value="42"                # set cell
officecli add deck.pptx / --type slide --prop title="Title"         # add slide
officecli create file.hwpx                                          # create blank HWPX
officecli hwp doctor --json                                         # HWP/rhwp readiness
officecli create file.hwp --json                                    # create blank HWP when rhwp-field-bridge is ready
officecli add file.hwp /text --type paragraph --prop value="..." --prop output=out.hwp --json
officecli view file.hwp pdf --out out.pdf --json                    # export HWP through rhwp sidecars
officecli set file.hwp /native-op --prop op=split-paragraph --prop output=out.hwp --json
officecli validate file.docx                                        # validate
officecli get file.docx / --json                                    # JSON output
echo '[...]' | officecli batch data.xlsx --json                     # batch ops
```

#### OfficeCLI Rebase Hygiene

When rebasing the `officecli` submodule fork onto `iOfficeAI/OfficeCLI`, preserve the HWP/rhwp commits and keep generated Rust outputs out of history.

```bash
cd officecli
git fetch upstream
git status --short --branch
git branch backup/feat-hwpx-pre-rebase-$(date +%y%m%d-%H%M) feat/hwpx
git tag backup/feat-hwpx-pre-rebase-$(date +%y%m%d-%H%M) feat/hwpx
```

- Rebase onto `upstream/main`, then resolve conflicts by preserving upstream OfficeCLI core changes plus local HWP/rhwp routing, help, capability, fixture, and bridge code.
- If `src/rhwp-field-bridge/target/` or any Rust `target/` output blocks rebase/cherry-pick, move or delete that generated directory before continuing. It is build output, not source.
- If an old commit accidentally stages Rust build artifacts, stop before committing and run `git rm -r --cached src/rhwp-field-bridge/target` plus `rm -rf src/rhwp-field-bridge/target`; commit only source, fixtures, tests, and docs.
- After every rebase, verify `git ls-files 'src/rhwp-field-bridge/target/*' | wc -l` returns `0`.
- Required checks before force-pushing the rebased feature branch:
  - `dotnet build officecli.slnx`
  - `cargo build --manifest-path src/rhwp-field-bridge/Cargo.toml`
  - `dotnet test tests/OfficeCli.Tests/OfficeCli.Tests.csproj --filter FullyQualifiedName~HwpBridge --no-build`
  - `dotnet test tests/OfficeCli.Tests/OfficeCli.Tests.csproj --no-build`
- Push rebased `feat/hwpx` with `git push --force-with-lease origin feat/hwpx`, then commit the updated `officecli` submodule pointer in this repo.
