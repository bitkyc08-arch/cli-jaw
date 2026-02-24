# 260226 Fallback Retry 로직 개선

## 🔍 현재 문제

현재 `src/agent/spawn.js`의 폴백 로직:
- CLI 실행 실패(exit != 0) → `settings.fallbackOrder`에서 대체 CLI 탐색
- `_isFallback: true` 플래그로 1회 폴백만 허용 (무한루프 방지)
- **문제**: 한번 폴백되면 그 이후 요청에서도 계속 폴백 CLI를 사용하는 상황 발생
  - 원인: `settings.cli` 자체가 바뀌거나, 폴백 상태가 sticky하게 유지됨
  - 유저가 settings를 다시 저장(save)하기 전까지는 원래 CLI로 돌아가지 않음

## ✅ 목표

1. **폴백 후 3회까지는 원래 CLI를 먼저 재시도** — 매 요청마다 원본 CLI를 한번 시도
2. **3회 연속 실패 시 폴백 고정** — 이후부터는 폴백으로 직행
3. **유저가 save하면 상태 리셋** — `saveSettings()` 호출 시 폴백 카운터 초기화

## 📐 설계

### 데이터 구조

```js
// spawn.js 또는 별도 모듈에 module-level state 추가
const fallbackState = new Map();
// key: originalCli (string)
// value: { fallbackCli, retriesLeft: 3, lastFailTime }
```

### 로직 플로우

```
요청 들어옴 → settings.cli 확인
  ├─ fallbackState에 해당 CLI 없음 → 정상 실행
  │    ├─ 성공 → 완료
  │    └─ 실패 → fallbackState.set(cli, { fallbackCli, retriesLeft: 3 })
  │             → fallbackCli로 재시도
  │
  └─ fallbackState에 해당 CLI 있음
       ├─ retriesLeft > 0 → 원본 CLI 먼저 시도
       │    ├─ 성공 → fallbackState.delete(cli) (복귀!)
       │    └─ 실패 → retriesLeft-- → fallbackCli로 재시도
       │
       └─ retriesLeft === 0 → 원본 건너뛰고 바로 fallbackCli 실행
```

### 리셋 조건

- `saveSettings()` 호출 시 → `fallbackState.clear()`
- 유저가 CLI 변경 시 → 해당 CLI의 fallbackState 삭제
- 원본 CLI 재시도 성공 시 → fallbackState 삭제 (자동 복귀)

## 📁 변경 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/agent/spawn.js` | fallbackState Map 추가, 재시도 로직 개편, resetFallbackState export |
| `server.js` | saveSettings 호출 후 resetFallbackState() 호출 |
| (optional) `src/core/config.js` | fallback 관련 설정 상수 (MAX_RETRIES = 3) |

## 🔧 구현 체크리스트

- [ ] **Step 1**: `spawn.js`에 fallbackState Map + resetFallbackState() 추가
- [ ] **Step 2**: 기존 폴백 로직(line ~350, ~489)을 재시도 카운터 통합으로 리팩터
  - 폴백 발동 시: `fallbackState.set(cli, { fallbackCli, retriesLeft: 3 })`
  - 이후 요청 시: retriesLeft 체크 → 원본 시도 or 바로 폴백
- [ ] **Step 3**: 원본 CLI 재시도 성공 시 fallbackState.delete(cli) 로직
- [ ] **Step 4**: `server.js`의 `applySettingsPatch()`와 기타 saveSettings 호출부에 resetFallbackState() 연동
- [ ] **Step 5**: 테스트 — 폴백 → 3회 재시도 → 고정 시나리오 검증
- [ ] **Step 6**: 커밋 & 푸시

## ⚙️ 설정값

```js
const FALLBACK_MAX_RETRIES = 3;  // 폴백 후 원본 재시도 횟수
```

## 🧪 검증 시나리오

1. CLI A 실패 → 폴백 CLI B 성공 → 다음 3회는 A 먼저 시도
2. A가 3회 모두 실패 → 4번째부터 B 직행
3. 유저가 settings save → fallbackState 초기화 → A부터 다시 시작
4. A 재시도 중 1회라도 성공 → fallbackState 삭제, A 완전 복귀

## 📝 참고

- 현재 폴백 지점 2곳:
  - **line ~350**: Copilot CLI 전용 (mainManaged && code !== 0)
  - **line ~489**: 일반 CLI (error event 또는 비정상 종료)
- 두 곳 모두 동일한 로직 적용 필요
- `_isFallback` 플래그는 유지 — 폴백 요청 자체의 재폴백 방지 용도
