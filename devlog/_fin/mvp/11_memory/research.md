# Phase 11 메모리 — 설계 (v3)

> 2026-02-23. 비동기 메모리 flush + Claude memory 활용.

---

## 1. 아키텍처

```
[메인 대화]
msg 1 → DB
msg 2 → DB
...
msg N → DB → count % THRESHOLD === 0?
              ├─ NO → 계속
              └─ YES → triggerMemoryFlush() (비동기, 논블로킹)
                        → 별도 CLI spawn (forceNew + internal)
                        → "최근 N개 대화를 영어로 요약 → memory 파일에 저장"
                        → CLI가 Write 도구로 ~/.cli-claw/memory/YYYY-MM-DD.md append

[새 세션 시작 시]
getSystemPrompt()
  → A-1 + A-2 + employees
  → + loadRecentMemories(5) ← 최근 메모리 5개 주입
```

---

## 2. 트리거: 카운트 vs 시간

### DB 통계 (실측)

| 구분              | 평균        | 최대       | 비고                  |
| ----------------- | ----------- | ---------- | --------------------- |
| user 메시지       | 79 chars    | 5038 chars | 짧은 한국어 질문 다수 |
| assistant 메시지  | 314 chars   | 1619 chars | 코스트 라인 포함      |
| 10 메시지 (5 QA)  | ~3930 chars |            | ~1200 토큰            |
| 20 메시지 (10 QA) | ~7860 chars |            | ~2400 토큰            |

### 비교

| 방식                   | 장점                   | 단점                     |
| ---------------------- | ---------------------- | ------------------------ |
| **카운트 기반 (10개)** | 구현 간단, 대화량 비례 | 빈 대화("ㅎㅇ")도 카운트 |
| **카운트 기반 (20개)** | 의미 있는 대화 축적    | 간격 너무 넓을 수 있음   |
| **시간 기반 (30분)**   | 일정 주기              | 대화 없으면 빈 호출      |
| **하이브리드**         | 정확                   | 복잡                     |

### 결론: **카운트 10개 (5 QA턴)** 추천

- 10개 = ~1200 토큰 → 요약 프롬프트에 넣기 적당
- 짧은 대화는 요약할 게 없어서 "SKIP" 리턴하게 프롬프팅
- 추후 settings로 조절 가능 (`settings.memory.flushEvery`)

---

## 3. 요약 분량 + 영어 정책

### 요약 프롬프트 (영어 출력 강제)

```
You are a conversation memory extractor.
Summarize the conversation below into ENGLISH structured memory entries.

Rules:
- Output 2-4 bullet points, each 1 sentence
- Skip greetings, small talk, errors — only meaningful decisions/facts
- If nothing worth remembering, output exactly: SKIP
- Format: "- [topic]: [fact]"

Example output:
- [project-setup]: User prefers Claude Code as primary CLI with auto permissions
- [memory-design]: Decided on count-based flush every 10 messages with English summaries
- [preference]: User wants Korean UI but English internal processing

Conversation:
{recent_messages}
```

### 요약 저장 형식

```markdown
## 12:03 — Memory Flush #42

- [cli-config]: User set working directory to ~/Developer/new
- [orchestration]: Planning agent uses Claude, sub-agents use Codex
- [preference]: User wants memory summaries in English only
```

### 토큰 예산

| 항목                  | 토큰      |
| --------------------- | --------- |
| 입력: 시스템 프롬프트 | ~200      |
| 입력: 최근 10 메시지  | ~1200     |
| 출력: 요약 (2-4줄)    | ~100      |
| **합계**              | **~1500** |

→ 가장 저렴한 모델로 충분 (gpt-5-mini, gemini-flash 등)

---

## 4. 새 세션 메모리 주입

```javascript
function loadRecentMemories(maxEntries = 5) {
    const memDir = join(CLAW_HOME, 'memory');
    if (!fs.existsSync(memDir)) return '';
    
    const files = fs.readdirSync(memDir)
        .filter(f => f.endsWith('.md'))
        .sort().reverse();
    
    // 각 파일에서 ## 섹션 추출, 최신 N개만
    const entries = [];
    for (const f of files) {
        const content = fs.readFileSync(join(memDir, f), 'utf8');
        const sections = content.split(/^## /m).filter(Boolean);
        for (const s of sections) {
            if (!s.includes('SKIP')) entries.push(s.trim());
            if (entries.length >= maxEntries) break;
        }
        if (entries.length >= maxEntries) break;
    }
    
    return entries.map(e => `- ${e.split('\n').slice(1).join('\n  ')}`).join('\n');
}
```

주입 위치: `getSystemPrompt()` 끝 + `isResume=false` 일 때만 stdin에 포함.

---

## 5. 구현 체크리스트

- [ ] 11.1 `triggerMemoryFlush()` — 10개마다 비동기 spawn
- [ ] 11.2 flush 프롬프트 (영어 요약, SKIP 로직)
- [ ] 11.3 `loadRecentMemories(5)` — 새 세션 시 주입
- [ ] 11.4 `settings.memory` — `{ enabled, flushEvery, retentionDays }`
- [ ] 11.5 Settings UI — 메모리 on/off, 주기 조절
- [ ] 11.6 (선택) 오래된 raw → 압축 요약

---

## 6. 레퍼런스 비교

| 시스템              | 트리거        | 저장                       | 검색          | 임베딩       |
| ------------------- | ------------- | -------------------------- | ------------- | ------------ |
| OpenClaw            | 토큰 임계값   | `memory/YYYY-MM-DD.md`     | vector+FTS5   | ✅ 필요       |
| ChatGPT             | 자동/명시적   | system prompt notepad      | background    | ❌ 불필요     |
| novel-automation    | 매 회차       | SQLite + embedding         | 4-tier hybrid | ✅ 필요       |
| **cli-claw (계획)** | **10 메시지** | **`memory/YYYY-MM-DD.md`** | **최신 5개**  | **❌ 불필요** |
