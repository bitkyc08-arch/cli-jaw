# Phase 6: Copilot 할당량 + 추론강도 + CLI-CLAW 브랜딩 + UI 정합성

> 완료: 2026-02-25T00:38

---

## 6.1 Copilot 할당량 표시

### 인증 토큰

Copilot CLI는 `gh auth`와 **별도 인증** (macOS keychain):

```bash
security find-generic-password -s "copilot-cli" -w
# → gho_ImRi4X... (40자 OAuth)  account: jondo1323
```

### API

```
GET https://api.github.com/copilot_internal/user
Authorization: token {copilot-cli keychain token}
Editor-Version: vscode/1.95.0
```

### 핵심 발견 🎉

**Pro+ 계정에서 Copilot CLI chat은 모든 모델 무제한!**

| quota | remaining | unlimited | 비고 |
|-------|:---------:|:---------:|------|
| `chat` | 0 | **True** ♾️ | CLI chat 전부 여기 |
| `completions` | 0 | **True** ♾️ | IDE 자동완성 |
| `premium_interactions` | 66 | False | CLI chat에서 미차감 |

실제 테스트 결과:
- `claude-sonnet-4.6` (1x) × 3회 → premium **0** 차감
- `claude-opus-4.6` (3x) × 1회 → premium **0** 차감
- DB에서 `copilot | claude-opus-4.6` 모델 확인 완료

### 구현

#### [NEW] `lib/quota-copilot.js` (67L)

- macOS keychain에서 토큰 읽기 (1회 팝업, 이후 메모리 캐싱)
- `copilot_internal/user` API 호출 (`AbortSignal.timeout(8000)`)
- 기존 `renderCliStatus()` 호환 구조체 반환

#### [MODIFY] `server.js`

- `import { fetchCopilotQuota }` 추가
- `/api/quota` 라우트에 copilot 추가

---

## 6.2 추론강도 (Reasoning Effort) — 비활성화

### 경위

1. 초기 계획: `--reasoning-effort` CLI 플래그 전달
2. **테스트 결과**: Copilot CLI가 `--reasoning-effort` 미지원
3. 대안: `~/.copilot/config.json` 직접 수정 (Method A)
4. **최종 결정**: UI effort 비활성화 (글로벌 config.json은 외부 영향 있음)

### 현재 상태

| 항목 | 값 |
|------|------|
| `cli-registry.js` copilot.efforts | `['low', 'medium', 'high']` |
| `cli-registry.js` copilot.defaultEffort | `'high'` |
| `cli-registry.js` copilot.effortNote | `'→ ~/.copilot/config.json'` (tooltip) |
| UI per-CLI effort 드롭다운 | **활성** — low/medium/high 선택 가능 |
| Active CLI effort 드롭다운 | **활성** — tooltip에 config.json 안내 |
| `agent.js` config.json 쓰기 | spawn 전 자동 (`effort=''` → 필드 삭제) |

> 사용자가 수동으로 `~/.copilot/config.json`에서 `reasoning_effort` 설정 가능

---

## 6.3 UI 브랜딩: CLAW → CLI-CLAW

`public/index.html` — 3곳:
- `<title>` → `🦞 CLI-CLAW`
- `<div class="logo">` → `🦞 CLI-CLAW`
- `<div class="chat-header">` → `🦞 CLI-CLAW ●`

---

## 6.4 UI 정합성 수정

### 6.4.1 Model 드롭다운 "default" 옵션

| 위치 | "default" | 이유 |
|------|:---------:|------|
| Active CLI selModel | ✅ | 소비자 — perCli 참조 |
| Per-CLI 설정 (🟣🟢🔵🟠💙) | ❌ | 소스 — 순환참조 방지 |
| Sub Agent | ✅ | 소비자 — CLI defaultModel 사용 |

### 6.4.2 Effort 드롭다운 UX

- 비어있는 efforts CLI → `effortNote` 필드 표시 + `disabled`
- Copilot: `~/.copilot/config.json` 힌트 표시

### 6.4.3 Fallback constants.js 동기화

- `constants.js` FALLBACK_CLI_REGISTRY copilot efforts/effortNote → server 동일

### 6.4.4 기타 정합성

| 수정 | 파일 |
|------|------|
| Copilot quota fetch 8s timeout | `quota-copilot.js` |
| Telegram origin 필터 | `telegram.js` |
| ACP optionId 폴백 (value/id/optionId) | `acp-client.js` |

---

## 커밋 로그

| 해시 | 메시지 |
|------|--------|
| `a4fc3e3` | phase 6: branding, quota, effort config.json |
| `4a6ea0c` | docs: str_func + README, 3 consistency fixes |
| `ae9fc8f` | fix: effort='' deletes reasoning_effort |
| `e691617` | fix: disable copilot effort |
| `5a58057` | fix: add 'default' to Active CLI model |
| `7f24869` | fix: effortNote hint, telegram origin, ACP optionId |
| `2b00f0c` | fix: remove 'default' from per-CLI model |
| `04d88be` | fix: re-enable copilot effort (per-CLI settable, config.json) |
| `420dcce` | fix: Active CLI effort disabled for copilot, normalizeRegistry effortNote |
| `2397e2d` | fix: suppress 💭 thought chunk broadcasts (Web UI + Telegram + CLI) |
