# (fin) Phase A+ — Memory Flush 개선

> 상태: ✅ 구현 완료

## 변경 요약

### 기존 문제

1. **메시지당 800자 slice** — 정보 손실
2. **CHAR_BUDGET 15000자** — 불필요 (실제 flush 결과: 14줄, 1355 bytes)
3. **메시지 40개 하드코딩** — threshold(10/20 QA)와 불일치
4. **flush 메모리 33000자 프롬프트 주입** — 매 메시지마다 ~11K 토큰 소비
5. **MEMORY.md 프롬프트 주입 없음** — 새 메모리가 시스템 레벨로 안 들어감

### 적용된 변경

| 파일            | 변경                                           | 효과                                           |
| --------------- | ---------------------------------------------- | ---------------------------------------------- |
| `src/agent.js`  | `getRecentMessages.all(40)` → `all(threshold)` | flushEvery 설정과 동기화                       |
| `src/agent.js`  | 800자 slice 제거                               | 메시지 전체 전달                               |
| `src/agent.js`  | CHAR_BUDGET 15000 제거                         | threshold 갯수로 이미 제한                     |
| `src/agent.js`  | flush 프롬프트 줄글 변경                       | 1-3문장 prose로 토큰 절약                      |
| `src/prompt.js` | `loadRecentMemories` 33000→4000자              | 프롬프트 토큰 ~11K→~1.3K                       |
| `src/prompt.js` | `loadRecentMemories` 로그 추가                 | `[memory] session memory loaded:`              |
| `src/prompt.js` | MEMORY.md 시스템 레벨 주입                     | 1500자 제한, `[memory] MEMORY.md loaded:` 로그 |

### 구현 중 실수 기록

> ⚠️ `prompt.js` 수정 시 `getSystemPrompt()` 함수가 219줄에서 일찍 닫혀
> orchestration/heartbeat/skills 코드가 전역 스코프로 빠져나가는 문법 오류 발생.
> 원인: multi_replace에서 함수 닫는 `}` 위치를 잘못 지정.
> 수정: 전체 함수 범위를 확인하고 재작성.

### 프롬프트 토큰 예산 (변경 후)

| 항목                        | 제한        | 토큰(약)   |
| --------------------------- | ----------- | ---------- |
| Auto-flush (session memory) | 4000자      | ~1,300     |
| MEMORY.md (core memory)     | 1500자      | ~500       |
| **합계**                    | **~5500자** | **~1,800** |

### 서버 로그 출력

```
[memory] session memory loaded: 4 entries, 1355 chars
[memory] MEMORY.md loaded: 320 chars
[memory] flush triggered (10 msgs → codex/default)
```
