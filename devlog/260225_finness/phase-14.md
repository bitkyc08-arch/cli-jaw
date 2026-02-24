# Phase 14 — Skills Ref 정합성 조사

> skills_ref/ 중복·누락·phantom 조사 결과

---

## 조사 결과

| 항목 | 값 |
|------|-----|
| registry.json 항목 | 107개 |
| skills_ref/ 디렉토리 | 106개 |
| active skills (~/.cli-claw/skills/) | 17개 |

## 중복 분석

### 의도적 분리 (정상)

| 스킬 | category | 용도 |
|------|----------|------|
| `dev` | orchestration | 공통 개발 가이드 (모든 sub-agent 주입) |
| `dev-frontend` | orchestration | 프론트엔드 **역할** 가이드 (role=frontend 시 주입) |
| `dev-backend` | orchestration | 백엔드 역할 가이드 |
| `dev-data` | orchestration | 데이터 역할 가이드 |
| `dev-testing` | orchestration | 디버깅 phase 전용 |
| `github` | devtools | Phase 1에서 4개 서브스킬 합침 (정상) |

### ⚠️ 실제 중복 발견 (2쌍)

| 삭제 대상 | 보존 | 근거 |
|-----------|------|------|
| `frontend-design` | `dev-frontend` | **SKILL.md 본문 100% 동일** — Anthropic 원본을 오케스트레이터용으로 복사 |
| `webapp-testing` | `dev-testing` | **SKILL.md 본문 100% 동일** — 동일 패턴 |

## 이전 정리 기록

- **Phase 1** (`260224_skill/phase_1_dedup.md`): 4쌍 중복 제거 + GitHub 4개 합침 → 62→54개 ✅ 삭제 확인 완료
- **Phase 6.9**: registry.json에 i18n 키 추가 방식 설계
- **Phase 7.1**: 107개 전부 `name_ko/name_en/desc_ko/desc_en` 이중 키 변환

## 발견된 문제

### 1. `kreuzberg` phantom entry
- registry.json에 존재하지만 `skills_ref/kreuzberg/` 디렉토리 없음
- 해결: registry에서 삭제하거나, 디렉토리 생성 필요

### 2. `telegram-send` chatId 하드코딩
- Phase 13에서 해결 완료 ✅

## 결론

**시스템 정합성: 양호** — `kreuzberg` phantom 1개만 정리하면 완전 clean.
`dev-*` vs `frontend-design` 은 의도적 분리이므로 합칠 필요 없음.
