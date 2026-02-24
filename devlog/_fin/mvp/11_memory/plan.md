# Phase 11: 메모리 (대화 기억 유지)

openclaw 패턴: `shouldRunMemoryFlush()` → 토큰 임계값 도달 시 → `memory/YYYY-MM-DD.md`에 저장

## 구현 (경량화)

- [ ] 11.1 `loadRecentMemories(days)` + 시스템 프롬프트 주입
- [ ] 11.2 `settings.memory` 설정 (`enabled`, `retentionDays`)
- [ ] 11.3 Settings UI Memory 섹션

## 설계

claw는 CLI 세션을 매번 새로/resume하므로, 토큰 기반 flush 대신 **명시적 파일 기반 메모리**:

- 시스템 프롬프트에 메모리 저장 지시 추가:
  > "중요한 정보는 `~/.cli-claw/memory/YYYY-MM-DD.md`에 append 저장하세요"
- 새 세션 시작 시 `loadRecentMemories(N일)` → 최근 메모리 내용을 시스템 프롬프트에 주입
- 에이전트가 `Read`/`Write` 도구로 메모리 파일 직접 관리
- `settings.memory`: `{ enabled: true, retentionDays: 7 }`

## 레퍼런스

- `openclaw-ref/src/auto-reply/reply/memory-flush.ts` — `shouldRunMemoryFlush()`, `DEFAULT_MEMORY_FLUSH_PROMPT`
- `openclaw-ref/src/auto-reply/reply/agent-runner-memory.ts` — `runMemoryFlushIfNeeded()`
