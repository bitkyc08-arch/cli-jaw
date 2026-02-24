# Phase 7: Smart Agent Allocation + Phase Skip

> **의존**: Phase 6 완료
> **검증일**: 2026-02-24

---

## 문제

Phase 6 이후에도 비효율 잔존:
- TODO 검수에 5명 전원 투입 (기획부터)
- 모든 에이전트가 Phase 1(기획)부터 시작 → 같은 파일 반복 분석
- "검수해줘"인데 기획 phase를 거침

## 해결

### 7-A: 에이전트 수 최소화

planning prompt에 명시적 원칙 추가:
- 단일 파일/영역 → **1명**
- 프론트+백엔드 → **2명**
- 5명 전원 → **대규모 초기 설계에만**

### 7-B: start_phase로 Phase 스킵

subtask JSON에 `start_phase` 필드 추가:

```json
{
  "agent": "프런트",
  "role": "frontend",
  "task": "UI 검수",
  "start_phase": 4
}
```

| 작업 유형   | start_phase | 실행 phases |
| ----------- | ----------- | ----------- |
| 신규 개발   | 1           | 1→2→3→4→5   |
| 리팩토링    | 3           | 3→4→5       |
| 버그 수정   | 4           | 4→5         |
| 검수/테스트 | 4           | 4→5         |
| 문서 작업   | 3           | 3→5         |

`initAgentPhases()`: `fullProfile.filter(p => p >= startPhase)`

## 변경 파일

| 파일                  | 작업                              | 변경                            |
| --------------------- | --------------------------------- | ------------------------------- |
| `src/orchestrator.js` | planning prompt + initAgentPhases | start_phase, 최소 에이전트 원칙 |

## 기대 효과

```
Before: "검수해줘" → 5명 × 5 phases = 25 agent 호출
After:  "검수해줘" → 1명 × 2 phases (4→5) = 2 agent 호출
```
