# Phase 9.7: 의존성 검증 게이트 실행

> Phase 8.5 설계 기반. 오프라인/온라인 이중 게이트로 의존성 보안 검증 체계 구축.

---

## 생성 파일

| 파일 | 역할 | 상태 |
|---|---|---|
| `scripts/check-deps-offline.mjs` | package-lock.json 기반 오프라인 취약 버전 체크 | ✅ 생성 |
| `scripts/check-deps-online.sh` | npm audit + outdated + semgrep (네트워크 필요) | ✅ 생성 |
| `tests/unit/deps-check.test.js` | semver helper 단위 테스트 10건 | ✅ 10/10 pass |

---

## 오프라인 게이트 규칙

| 패키지 | Advisory | 취약 범위 | 현재 버전 | 판정 |
|---|---|---|---|---|
| `ws` | GHSA-3h5v-q93c-6h6q | `>=8.0.0 <8.17.1` | `8.19.0` | ✅ PASS |
| `node-fetch` | GHSA-r683-j2x4-v87g | `<2.6.7` or `>=3.0.0 <3.1.1` | `3.3.2` | ✅ PASS |
| `node-fetch` (grammy transitive) | 동일 | `<2.6.7` | `2.7.0` | ✅ PASS |

---

## package.json 스크립트

```json
{
    "check:deps": "node scripts/check-deps-offline.mjs",
    "check:deps:online": "bash scripts/check-deps-online.sh"
}
```

---

## 추가 변경

- `.gitignore`에 `.artifacts/` 추가 (온라인 체크 결과 저장 디렉토리)

---

## 검증

```bash
# 오프라인 체크 — exit 0
node scripts/check-deps-offline.mjs
# PASS node_modules/ws@8.19.0
# PASS node_modules/node-fetch@3.3.2
# PASS node_modules/grammy/node_modules/node-fetch@2.7.0

# 단위 테스트
node --test tests/unit/deps-check.test.js  # 10/10 pass
```

---

## 완료 기준

- [x] 오프라인 스크립트 exit 0 (현재 환경)
- [x] `package.json`에 `check:deps` 스크립트 추가
- [x] `tests/unit/deps-check.test.js` 10/10 통과
- [x] `.artifacts/` `.gitignore`에 추가
- [ ] 취약 버전 강제 시 exit 1 확인 (수동 검증)
