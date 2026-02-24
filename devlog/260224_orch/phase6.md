# Phase 6: Message Triage + 순차 실행

> **의존**: Phase 5 완료
> **검증일**: 2026-02-24
> **산출물**: needsOrchestration, direct_answer, 순차 실행, 프롬프트 조정

---

## 6-A: 2-Tier Triage

### Tier 1: Regex 기반 (`needsOrchestration`)

**복잡한 작업만** orchestrate — 2개 이상 signal 필요:
1. 길이 ≥ 80자
2. 코드 키워드 (`.js`, `구현`, `수정`, `API`, `만들어` 등)
3. 파일 경로 (`src/`, `bin/`, `public/`)
4. 멀티 태스크 (`그리고`, `먼저`, 번호 목록)

| 입력                    | signal | 판정        |
| ----------------------- | ------ | ----------- |
| "안녕"                  | 0      | direct      |
| "그래서 대답이 뭐냐고"  | 0      | direct      |
| "API가 뭐야?"           | 1      | direct      |
| "src/agent.js 수정해줘" | 2      | orchestrate |

**16/16 unit test pass.**

### Tier 2: Planning Agent 자율 판단 (`direct_answer`)

Regex 통과한 메시지도 planning agent가 판단:

```json
{
  "direct_answer": "직접 응답 내용",
  "subtasks": []
}
```

`parseDirectAnswer()` 함수로 파싱, orchestrate()에서 즉시 broadcast.

---

## 6-B: 순차 실행

### 변경

`distributeByPhase`: `Promise.all` → **`for...of` 순차 루프**

### 프롬프트 조정 (orchestrator.js + prompt.js)

각 sub-agent에게 주입:
```
## 순차 실행 규칙
- 이전 에이전트가 이미 수정한 파일은 건드리지 마세요 (충돌 방지)
- 중복 작업을 하지 마세요
- 당신의 담당 영역(${role})에만 집중하세요

### 이전 에이전트 결과
- 프론트 (frontend): done — UI 수정 완료...
```

prompt.js `getSubAgentPromptV2`에도 순차 인식 추가:
- worklog 먼저 읽기
- 이미 수정된 파일 건드리지 않기
- 담당 영역에만 집중

---

## 파일 변경 요약

| 파일                  | 작업                                                                | L    |
| --------------------- | ------------------------------------------------------------------- | ---- |
| `src/orchestrator.js` | [MODIFY] needsOrchestration, parseDirectAnswer, 순차 실행, 프롬프트 | 583L |
| `src/prompt.js`       | [MODIFY] getSubAgentPromptV2 순차 실행 인식                         | 503L |

---

## 벤치마크
→ `devlog/260224_orch/benchmark.md` (30개 테스트, 5 Tier)
