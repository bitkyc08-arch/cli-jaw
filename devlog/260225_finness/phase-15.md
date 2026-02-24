# Phase 15 — 프롬프트 최적화 + A-1.md 복구

> 상태: 📋 계획 완료
> 우선순위: **P0** (현재 에이전트가 Browser Control / Git 안전장치 모름)

---

## 원인 분석

### A-1.md 리셋 원인

| 항목 | 값 |
|---|---|
| 파일 경로 | `~/.cli-claw/prompts/A-1.md` |
| 마지막 수정 | **2026-02-23 03:51:58** |
| 현재 크기 | 355 bytes (12줄) |
| 코드 기본값 | ~2000 bytes (66줄) |
| Git 추적 | ❌ (런타임 파일, 리포에 없음) |

**원인 추정**: 에이전트(Claw Agent) 자체가 `~/.cli-claw/prompts/A-1.md`를 직접 편집한 것으로 추정.
- `initPromptFiles()`는 파일 부재 시에만 생성 → 기존 파일 보호
- Web UI에 A-1.md 저장 API 없음 (코드에서 `writeFile.*A1` 검색 결과 `initPromptFiles`만 해당)
- 2/23 03:51에 에이전트가 파일을 축소 저장한 것으로 보임

### 현재 빠진 섹션

| 섹션 | 코드 기본값 | 현재 파일 | 영향 |
|---|---|---|---|
| Browser Control (MANDATORY) | ✅ 6줄 | ❌ | 에이전트가 `cli-claw browser` 패턴 모름 |
| Telegram File Delivery | ✅ 5줄 | ❌ | 동적 주입으로 커버됨 |
| Long-term Memory (MANDATORY) | ✅ 6줄 | ❌ | 동적 주입으로 부분 커버 |
| Heartbeat System (JSON 포맷) | ✅ 20줄 | ❌ | 새 잡 등록 방법 모름 |
| Git 안전장치 | ✅ 2줄 | ❌ | **위험**: git commit/push 무단 실행 가능 |

---

## Phase 15 작업 항목

### 15.1 A-1.md 복구 (P0)

**목표**: 코드 기본값 `A1_CONTENT` 기준으로 A-1.md 복원 + 주니 커스텀(`HEARTBEAT_OK`) 유지

**작업**:
1. `~/.cli-claw/prompts/A-1.md` → `A1_CONTENT` + `HEARTBEAT_OK` 규칙 병합
2. `regenerateB()` 호출 → B.md + AGENTS.md 갱신
3. 갱신된 B.md에 Browser Control / Git 안전장치 포함 확인

### 15.2 A-1.md 보호 메커니즘 (P1)

**문제**: 에이전트가 `~/.cli-claw/prompts/A-1.md`를 직접 편집 가능 → 핵심 섹션 유실 위험

**해결 방안** (택1):
- **(A) 코드 하드코딩**: A-1.md 파일 읽기를 폐지, `A1_CONTENT` 상수만 사용
  - 장점: 에이전트가 변경 불가
  - 단점: 사용자 커스텀 불가
- **(B) 병합 전략**: A-1.md + A1_CONTENT 병합 (사용자 추가 규칙 유지, 핵심 섹션은 코드에서 보장)
  - 장점: 커스텀 가능 + 핵심 보장
  - 단점: 구현 복잡
- **(C) 체크섬 검증**: A-1.md 변경 감지 → 경고 로그
  - 장점: 간단
  - 단점: 사후 대응

> 💡 **권장: (B)** — `getSystemPrompt()`에서 항상 `A1_CONTENT` 기본 주입 + A-1.md는 "추가 규칙"으로만 사용

### 15.3 프롬프트 토큰 최적화 (P2)

**현재 B.md 토큰 분석**:

| 섹션 | 추정 토큰 | 최적화 가능성 |
|---|---|---|
| A-1 (시스템 규칙) | ~200 | 낮음 (필수) |
| A-2 (사용자 설정) | ~80 | 낮음 (필수) |
| Telegram Active | ~60 | 중간 (A-1에 이미 포함 → 중복 가능) |
| Core Memory | ~500 (가변) | 중간 (1500자 제한 이미 있음) |
| Orchestration | ~250 | 높음 (직원 0명이면 생략 OK ← 이미 구현) |
| Heartbeat Jobs | ~100 | 낮음 |
| Skills Active | ~100 | 낮음 |
| Skills Ref (CSV) | ~200 | 높음 (필요 시 더 축소 가능) |
| Session Memory | ~300 (가변) | 중간 (이미 조건부) |
| **총합** | ~1800 | |

**최적화 대상**:
1. Telegram 중복 제거 — A-1에 Telegram 규칙 있는데 동적으로 또 주입 → 하나로 통합
2. Ref Skills CSV → 카테고리별 그룹핑 (에이전트 탐색 효율)
3. Session Memory 요약 압축 (현재 첫 줄만 추출, 더 짧게 가능)

### 15.4 프롬프트 구조 문서화 (P2)

**작업**:
1. `prompt_basic_A1.md` 최종 갱신 (복구 내용 반영)
2. `prompt_basic_B.md` 최종 갱신 (최적화 후 구조 반영)
3. `prompt_flow.md` Phase 15 변경사항 반영

---

## 검증 계획

### 자동 테스트

```bash
npm test    # 기존 테스트 회귀 확인
```

### 수동 검증

1. **B.md 확인**: `cat ~/.cli-claw/prompts/B.md | grep -c "Browser Control"` → 1 이상
2. **AGENTS.md 확인**: `cat ~/AGENTS.md | grep -c "git commit"` → 1 이상
3. **에이전트 테스트**: 서버 재시작 후 "browse google.com" → `cli-claw browser` 사용하는지 확인

---

## 구현 순서

```
15.1 A-1.md 복구          ← 즉시 (5분)
15.2 보호 메커니즘         ← 사용자 결정 후
15.3 토큰 최적화           ← 15.2 이후
15.4 문서 갱신             ← 마지막
```
