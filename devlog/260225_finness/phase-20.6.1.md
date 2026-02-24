# Phase 20.6.1 — Post-Refactoring 핫픽스 모음

> Phase 20.6 디렉토리 리팩토링 후 발견된 런타임/CI 에러 수정

---

## 1. PHASE_PROFILES/INSTRUCTIONS 복원 (`69f1015`)

**증상**: `ReferenceError: PHASE_PROFILES is not defined` (orchestrator.js:26)
**원인**: parser 추출 시 phase tracking 상수 2개 동시 삭제
**수정**: `orchestrator.js`에 `PHASE_PROFILES` + `PHASE_INSTRUCTIONS` 복원 (+36줄)

## 2. CI better-sqlite3 빌드 (`cd98294`)

**증상**: CI `npm ci --ignore-scripts` → `better-sqlite3` 네이티브 바인딩 누락
**원인**: Phase 20.6 import 체인 변경으로 모든 테스트가 `db.js` → `better-sqlite3` 로드
**수정**: `.github/workflows/test.yml`에 `prebuild-install` 스텝 추가

```yaml
- name: Build native modules
  run: cd node_modules/better-sqlite3 && npx --yes prebuild-install || npm run build-release
```

## 3. CI DB 디렉토리 부재 (4 fail)

**증상**: `TypeError: Cannot open database because the directory does not exist`
**원인**: CI 환경에 `~/.cli-claw/` 디렉토리 미존재 → `core/db.js` SQLite 초기화 실패
**상태**: db.js에 `mkdirSync` 추가 필요 (다른 에이전트에서 처리)

## 4. telegram/bot.js import 경로 — 6곳 (`0de6e23`)

**증상**: `ERR_MODULE_NOT_FOUND: src/telegram/agent/spawn.js`
**원인**: `bot.js`가 `src/telegram/` 안에 있는데 `./agent/spawn.js`로 import → `src/telegram/agent/spawn.js`로 해석
**수정**:

| 줄 | 변경 전 | 변경 후 |
|---|--------|--------|
| L14 | `./agent/spawn.js` | `../agent/spawn.js` |
| L112 | `./config.js` | `../core/config.js` |
| L155 | `./config.js` | `../core/config.js` |
| L182 | `./browser/index.js` | `../browser/index.js` |
| L190 | `./browser/index.js` | `../browser/index.js` |
| L283 | `./agent.js` | `../agent/spawn.js` |

## 5. orchestrator/pipeline.js import 경로 (`f3e8437`)

**증상**: `ERR_MODULE_NOT_FOUND: src/telegram/orchestrator/pipeline.js`
**수정**: `./orchestrator/pipeline.js` → `../orchestrator/pipeline.js`

---

## 교훈

대규모 디렉토리 이동 시:
1. **상대경로 전수 검사** 필수 — `grep -rn "from '\.\/" src/*/` 로 cross-subdir 참조 탐지
2. **CI에서도 서버 기동 테스트** — unit test만으로는 import 체인 커버 불가
3. **네이티브 모듈**은 `--ignore-scripts` 환경 고려
