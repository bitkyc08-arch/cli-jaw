# MVP-3: Prompt Injection (A-1/A-2/B)

프롬프트 삽입 하이브리드 구조 구현.

## 구조

```
~/.cli-claw/prompts/
├── A-1.md          ← 코어 (불변, 코드 내장)
├── A-2.md          ← 유저 (가변, UI에서 수정)
└── B.md            ← A-1+A-2 합성 (자동 생성)
```

## 체크리스트

- [ ] A-1.md 코어 프롬프트 작성 (하드코딩 + 파일 저장)
- [ ] A-2.md 기본값 생성 + `/api/prompt` PUT으로 수정
- [ ] `regenerateB()` — A-2 변경 시 B 자동 재생성
- [ ] `getSystemPrompt()` — A-1+A-2 합쳐서 리턴 (동적 CLI용)
- [ ] CLI별 주입:
  - claude: `--append-system-prompt` (A-1+A-2)
  - gemini: `--system-instruction` (A-1+A-2)
  - codex: `codex.md` → B.md symlink
  - opencode: `AGENTS.md` → B.md symlink
- [ ] symlink 설정 + 서버 시작 시 무결성 검증
- [ ] Memory mock 주입 (DB에서 읽어서 append — 있으면 넣고 없으면 스킵)
