# 파일 경로가 슬래시 커맨드로 오인되는 UX 버그 수정

> Date: 2026-02-25
> Commit: `bb46117`

## 증상
채팅에 `/users/junny/documents/blogproject/cli-claw-ts/devlog/str_func/prompt_basic_a1.md`
같은 파일 경로를 입력하면 "알 수 없는 커맨드" 에러 발생.

## 원인
`parseCommand()` (commands.ts L169)가 `/`로 시작하는 모든 텍스트를 슬래시 커맨드로 파싱.
파일 경로도 `/`로 시작 → `findCommand('users')` 실패 → `type: 'unknown'` → 에러 메시지.

## 수정

### `src/cli/commands.ts` — `parseCommand()`

```diff
 export function parseCommand(text: any) {
     if (typeof text !== 'string' || !text.startsWith('/')) return null;
     const body = text.slice(1).trim();
+    // File paths like /users/junny/... or /tmp/foo — not commands
+    const firstToken = body.split(/\s+/)[0] || '';
+    if (firstToken.includes('/') || firstToken.includes('\\')) return null;
     const parts = body.split(/\s+/);
```

### 판별 로직
- 슬래시 커맨드: `/help`, `/cli claude`, `/model gpt-5` → 첫 토큰에 `/` 없음
- 파일 경로: `/users/junny/...`, `/tmp/foo.txt` → 첫 토큰에 `/` 포함
- `\` 포함 케이스도 Windows 경로 대비

## 테스트
- 빌드 ✅
- 252 pass, 0 fail ✅
- 기존 모든 슬래시 커맨드 정상 동작 확인
