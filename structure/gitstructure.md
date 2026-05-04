---
created: 2026-03-27
tags: [cli-jaw, git, submodule, devlog]
aliases: [CLI-JAW Git Structure, cli-jaw 서브모듈 구조, Git Structure Guide]
---

> 📚 [INDEX](INDEX.md) · [체크리스트 ↗](AGENTS.md) · [str_func ↗](str_func.md) · **Git 구조 & 서브모듈**

# Git Structure Guide (CLI-JAW)

live working tree + `.gitmodules` 기준으로 정리한 Git 구조/운영 요약입니다. top-level prose docs와 다를 때는 실제 트리와 `.gitmodules`를 우선한다.

## 1) Repository Topology

```text
lidge-jun/cli-jaw              ← public parent repo
├── skills_ref/  (submodule)   ← lidge-jun/cli-jaw-skills (public)
├── devlog/      (submodule)   ← lidge-jun/cli-jaw-internal (private)
├── officecli/   (submodule)   ← lidge-jun/OfficeCLI (public)
└── .npmignore                 ← npm publish 시 submodule 제외
```

- `skills_ref/`: 스킬 레퍼런스 저장소
- `devlog/`: 내부 개발 로그/계획 저장소
- `officecli/`: Office 문서 도구용 별도 submodule
- parent repo 기준 `git status`에는 이 3개 submodule이 독립 항목으로 보인다
- 현재 `.gitmodules`와 `git submodule status` 기준으로 세 submodule 모두 live tree에 존재한다
- `AGENTS.md`/`CONTRIBUTING.md` 일부 문단은 아직 `officecli/`를 생략하고 있어도, 구조 문서의 기준은 live tree다

## 2) Clone Strategy

```bash
# 코드만 (일반 사용자/CI)
git clone https://github.com/lidge-jun/cli-jaw.git

# 코드 + submodule 전체
git clone --recursive https://github.com/lidge-jun/cli-jaw.git

# 이미 clone 후 submodule 초기화
git submodule update --init --recursive
```

## 3) Submodule Commit Flow (중요)

서브모듈 내용을 바꿨다면 반드시 2단계로 커밋합니다.

```bash
# 1) submodule 내부에서 먼저 커밋/푸시
cd skills_ref   # 또는 cd devlog / cd officecli
git add -A
git commit -m "update"
git push
cd ..

# 2) parent repo에서 submodule ref 업데이트 커밋
git add skills_ref   # 또는 git add devlog / git add officecli
git commit -m "chore: update skills_ref ref"
git push
```

핵심: submodule commit과 parent repo ref commit은 별개입니다.

## 4) devlog / internal policy

- `devlog/`는 private submodule입니다.
- devlog 내부 문서는 `devlog/AGENTS.md`와 하위 `AGENTS.md`를 우선 따른다.
- 접근 필요 시 이슈에서 collaborator 권한 요청:
  - https://github.com/lidge-jun/cli-jaw/issues

## 5) PR & Quality Gate

PR 전 최소 검증:

```bash
npm run build
npm test
npm run typecheck
bash devlog/structure/check-doc-drift.sh
bash devlog/structure/verify-counts.sh
```

추가로 실제 `package.json`에는 아래 스크립트들이 있다.

- `npm run build:frontend`
- `npm run test:all`
- `npm run test:integration`
- `npm run test:smoke`
- `npm run prepublishOnly`

## 6) str_func 문서 동기화 규칙

`AGENTS.md` 규칙:

- `str_func.md` 파일 트리 라인수 표기 형식: `(NNNL)`
- 파일 수정 후 동기화 검증:

```bash
bash devlog/structure/verify-counts.sh
```

- 자동 보정:

```bash
bash devlog/structure/verify-counts.sh --fix
```

## 7) Devlog 운영 규칙

- 완료된 phase는 `devlog/_fin/`으로 이동
- `devlog/` 루트에는 진행 중 항목만 유지
- 후순위 항목은 `269999_` 접두사 사용

## 8) Structure Sync Scope

- `server.ts`가 route glue layer로 바뀌었으므로 API 변경은 `src/routes/*`와 `devlog/structure/server_api.md`를 함께 본다.
- CLI command transport 변경은 `src/cli/handlers.ts`, `src/cli/handlers-runtime.ts`, `src/cli/handlers-completions.ts`, `src/cli/api-auth.ts`와 `devlog/structure/commands.md`를 같이 동기화한다.
- prompt/spawn 구조 변경은 `src/prompt/*`, `src/agent/*`, `src/orchestrator/*`와 `devlog/structure/prompt_flow.md`, `prompt_basic_*.md`, `agent_spawn.md`를 같이 본다.
- memory/heartbeat runtime 변경은 `src/memory/*`, `src/routes/memory.ts`, `src/routes/jaw-memory.ts`, `src/routes/heartbeat.ts`와 `memory_architecture.md`, `telegram.md`, `infra.md`를 같이 본다.
- 큰 refactor 뒤에는 parent repo quality gate와 별개로 `devlog/structure` drift 검사까지 같이 통과시킨다.
