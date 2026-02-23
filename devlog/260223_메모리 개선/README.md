# 260223: cli-claw 메모리 관리 로직 개선 방안 🧠

현재 `cli-claw`의 메모리 관리 로직과 `claw-lite/openclaw-ref`에서 구현된 진보된 메모리/컨텍스트 검색 방식을 비교 분석하고, 이를 바탕으로 `cli-claw`에 도입할 수 있는 개선안을 정리했습니다.

---

## 1. 현재 `cli-claw`의 메모리 관리 분석

`cli-claw`는 현재 비교적 단순하고 선형적인 **요약 기반의 마크다운 저장 방식**을 사용하고 있습니다.

### 핵심 동작 로직 (`src/agent.js`, `src/db.js`)
* **SQLite 기록:** 모든 메시지는 SQLite (`messages` 테이블)에 누적됩니다.
* **주기적 플러시:** 채팅 세션이 끝날 때마다 `memoryFlushCounter`가 증가하며, 기본 설정값(예: 20턴)에 도달하면 `triggerMemoryFlush()` 함수가 백그라운드 모델(기본 모델 또는 지정된 flush 모델)을 호출합니다.
* **LLM 요약:** 가장 최근 메시지들(약 40개)을 취합해 LLM 프롬프트에 전달하고, "결정, 사실, 선호도, 프로젝트 정보" 등만 2~5개의 영문 불릿 포인트로 요약하도록 지시합니다.
* **파일로 저장:** 요약된 내용은 날짜별 마크다운 파일(예: `2026-02-23.md`)에 `append` 됩니다.

```javascript
// cli-claw/src/agent.js 중 메모리 플러시 로직 발췌
async function triggerMemoryFlush() {
    const recent = getRecentMessages.all(40).reverse();
    // ... 프롬프트 구성 ...
    const flushPrompt = `You are a conversation memory extractor.
Summarize the conversation below into ENGLISH structured memory entries.
Save by APPENDING to this file: ${memFile}
// ...`;
    
    // 백그라운드로 LLM 요약 에이전트 실행
    spawnAgent(flushPrompt, { forceNew: true, internal: true, agentId: 'memory-flush' });
}
```

### 🔴 문제점 및 한계
1. **맥락 유실:** LLM이 요약하면서 구체적인 코드 스니펫이나 디버깅 단서 등 세부 정보가 사라집니다.
2. **검색 한계:** 마크다운 파일에 텍스트로만 저장되므로, 추후 유사한 주제에 직면했을 때 의미 기반(Semantic) 검색을 수행할 수 없고 단순히 파일을 읽어오는 수준에 머뭅니다.

---

## 2. `claw-lite/openclaw-ref`의 진보된 메모리 시스템

`openclaw-ref`의 `src/memory/` 폴더를 분석한 결과, 본격적인 **임베딩(Embedding) 기반의 RAG (Retrieval-Augmented Generation) 시스템**을 내장하고 있습니다. 

### 핵심 기능 (`src/memory/manager.ts`, `sqlite-vec.ts`, `hybrid.ts`)
* **Vector DB 도입:** SQLite에 `sqlite-vec` 확장 기능을 적용하여 FTS(Full Text Search)와 Vector 데이터를 동시에 다루고 있습니다.
* **하이브리드 검색 (`hybrid.ts`):** 단순 키워드 매칭(BM25/FTS)과 벡터 임베딩 유사도 검색을 결합하여, 코드 스니펫이나 과거 결정 사항을 아주 정확하게 찾아옵니다.
* **비동기 배치 처리:** 채팅을 멈추고 요약하는 것이 아니라, `batch-runner.ts`와 파일 감시자(`chokidar`)를 이용해 대화 내용과 파일을 백그라운드에서 임베딩하고 색인합니다.
* **고급 컨텍스트 관리 (`mmr.ts`, `temporal-decay.ts`):** 검색 결과의 다양성을 확보하기 위해 MMR (Maximal Marginal Relevance) 알고리즘을 사용하고, 너무 오래된 기억의 가중치를 낮추는 시간 감쇠(Temporal Decay) 로직을 적용했습니다.

```typescript
// openclaw-ref/src/memory/manager.ts 구조 스니펫
import type { DatabaseSync } from "node:sqlite";
import { type FSWatcher } from "chokidar";
import { searchKeyword, searchVector } from "./manager-search.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";

// FTS 테이블과 Vector 테이블을 모두 운영
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  // 백그라운드 배치 임베딩, 파일 감시(watcher), FTS 및 Vector 검색 병합 수행
}
```

---

## 3. `cli-claw` 개선 방안 (Action Item)

`openclaw-ref`의 방식을 차용하여 `cli-claw`의 메모리 로직을 다음과 같이 개선할 것을 제안합니다.

### 💡 개선 1단계: SQLite 기반 Vector 데이터베이스 도입
* `sqlite-vec` 또는 타 임베딩 솔루션을 도입하여 현재의 텍스트 메시지 로그를 백그라운드에서 임베딩합니다.
* 마크다운 요약본 파일 생성은 유지하되, 전체 원시 대화 텍스트 자체를 Vector 공간에 저장하여 구체적인 과거 코드 스니펫 복구를 가능하게 합니다.

### 💡 개선 2단계: 하이브리드 검색 적용 (RAG 파이프라인)
* 에이전트가 사용자의 메시지를 받을 때마다 관련된 과거 기억을 검색합니다.
* `FTS (Full Text Search)` + `Vector Search` 두 가지 쿼리를 날려 결과를 병합합니다. (예: BM25 점수 + 코사인 유사도 점수 결합)
* 이를 통해 LLM 프롬프트에 가장 관련성 높은 과거 대화 로그 5~10개를 Context로 주입합니다.

### 💡 개선 3단계: 시간 감쇠(Temporal Decay) 필터링
* 오래된 프로젝트 결정보다 최근 1주일간의 대화가 더 중요하므로, 검색 스코어 산정 시 최근 대화일수록 가중치를 주는 알고리즘(`temporal-decay.ts` 개념)을 추가합니다.

### 📝 기대 효과
* 대화가 길어져도(토큰 초과) 과거의 **특정 해결책이나 코드 작성 내역을 잊어버리는 문제(Catastrophic Forgetting)가 완벽히 해결**됩니다.
* 마크다운 요약 파일(`triggerMemoryFlush`)에 의존하던 추상적인 기억 체계에서, **코드 레벨의 정확도를 가진 검색 시스템**으로 진화하게 됩니다.
