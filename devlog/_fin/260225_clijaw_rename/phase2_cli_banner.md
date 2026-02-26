# Phase 2: CLI 배너 개선

> Status: **✅ 완료** (2025-02-25 17:35)
> Parent: `260225_clijaw_rename/plan.md`

## 변경 사항

### `bin/commands/chat.ts`

1. **블록 아트 배너** — `██╗` 스타일 CLIJaw ASCII art (테두리 없음, cyan bold)
2. **Active 모델 표시** — `/api/session` → `model` (plan의 활성 모델), perCli 폴백
3. **copilot 엔진 추가** — `cliLabel`/`cliColor`에 copilot (cyan) 추가
4. **API 응답 unwrap** — `res.data || res` 패턴으로 `{ ok, data }` 래핑 처리

### 모델 우선순위

1. `/api/session` → active plan 모델 (예: `claude-opus-4.6-fast`)
2. `settings.perCli[cli].model` → 설정된 기본값 (폴백)

### Before
```
  cli-jaw v0.1.0

  engine:    copilot
  directory:  ~
  server:    ● localhost:3457
```

### After
```
  ██████╗██╗     ██╗     ██╗ █████╗ ██╗    ██╗
  ██╔════╝██║     ██║     ██║██╔══██╗██║    ██║
  ██║     ██║     ██║     ██║███████║██║ █╗ ██║
  ██║     ██║     ██║██   ██║██╔══██║██║███╗██║
  ╚██████╗███████╗██║╚█████╔╝██║  ██║╚███╔███╔╝
   ╚═════╝╚══════╝╚═╝ ╚════╝ ╚═╝  ╚═╝ ╚══╝╚══╝
  v0.1.0

  engine:    Copilot
  model:     claude-opus-4.6-fast
  directory:  ~
  server:    ● localhost:3457
```
