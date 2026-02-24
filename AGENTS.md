# CLI-Claw

System-level AI agent with full computer control via CLI wrapping (claude, codex, gemini).

## Devlog Conventions

### Line Count Format (`str_func.md`)

File tree の行数は **`(NNNL)`** 형식으로 기재. 두 가지 변형 허용:

```
├── server.js          ← 설명 (757L)           ← 단순 형식
├── chat.js            ← 설명 (3모드, ..., 843L) ← 다중 메타 형식
```

- 숫자 + `L` + `)` 또는 `,` 로 끝나야 detection 가능
- 검증: `bash devlog/verify-counts.sh` (exit code = 불일치 수)
- 자동 수정: `bash devlog/verify-counts.sh --fix`
- **파일 수정 후 반드시 verify-counts 실행해서 문서 동기화**

### Devlog Archive (`devlog/_fin/`)

- 완료된 phase 폴더는 `devlog/_fin/`으로 이동
- `devlog/` 루트에는 진행 중인 폴더만 유지
- 후순위 작업은 `269999_` 접두사로 표시

### Phase Document Frontmatter

```yaml
---
created: 2026-MM-DD
status: planning | done | deferred
tags: [cli-claw, ...]
---
# (fin) Phase Title    ← 구현 완료 시 (fin) 접두사
```

- `status:` 필드 필수 — `planning`, `done`, `deferred` 중 택 1
- 구현 완료된 문서 제목에 `(fin)` 접두사 추가
