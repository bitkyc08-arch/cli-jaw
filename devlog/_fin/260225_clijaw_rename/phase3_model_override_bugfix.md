# Phase 3: activeOverrides 모델 오버라이드 버그 수정

> Status: **✅ 핫픽스** (2025-02-25 17:55)
> 심각도: **Critical** — 에이전트 자동 취소 유발

---

## 증상

- 웹 UI에서 Active CLI → Copilot → Model: `claude-opus-4.6-fast` 설정
- 메시지 전송 시 **planning agent가 `claude-sonnet-4.6`으로 spawn** (perCli 기본값)
- Copilot CLI가 `~/.copilot/config.json`과 `--model` 플래그 간 충돌로 **"Operation cancelled by user"** 발생
- 유저는 취소하지 않았는데 ~20초 만에 자동 종료

## 원인

`spawn.ts:228`에서 planning/employee agent는 **의도적으로 `activeOverrides`를 건너뛰고 있었음**:

```typescript
// Before (버그)
const ao = (!opts.internal && !opts.agentId) ? (settings.activeOverrides?.[cli] || {}) : {};
```

- `agentId`가 있으면 (`planning`, `employee-xxx` 등) → `ao = {}` → `cfg.model` 폴백
- `cfg.model` = `perCli.copilot.model` = `claude-sonnet-4.6` (기본값)
- planning agent가 config.json을 `claude-sonnet-4.6`으로 덮어쓰기 → main agent와 충돌

## 수정

```diff
- const ao = (!opts.internal && !opts.agentId) ? (settings.activeOverrides?.[cli] || {}) : {};
+ const ao = settings.activeOverrides?.[cli] || {};
```

**모든 에이전트**(main, planning, employee)가 `activeOverrides`의 모델을 사용하도록 변경.
`opts.model`이 명시적으로 전달된 경우 여전히 최우선 (memory-flush 등).

## 모델 우선순위 (수정 후)

```
opts.model > activeOverrides[cli].model > perCli[cli].model > 'default'
```

## 교훈

1. **`~/.copilot/config.json` 동기화의 부작용**: spawn 시 config.json에 모델을 쓰므로, 다른 모델로 spawn되는 agent가 config.json을 덮어써서 레이스 컨디션 발생
2. **activeOverrides는 유저의 "지금 쓰겠다"는 의사** — internal agent만 제외해야지 planning/employee까지 제외하면 안 됨
3. **배너 표시용 API fetch와 실제 spawn 모델이 일치해야 함** — 표시는 `claude-opus-4.6-fast`인데 실제 spawn은 `claude-sonnet-4.6`이면 유저 혼란

## 영향 파일

| 파일 | 변경 |
|------|------|
| `src/agent/spawn.ts:228` | `activeOverrides` 조건 제거 (1줄) |
