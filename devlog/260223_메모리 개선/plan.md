# 메모리 개선 — cli-claw 장기 기억 시스템

> Phase A: grep 기반 → Phase B: 임베딩 업그레이드

## 문제

cli-claw은 세션 간 기억이 없다.
Claude Code는 자체 memory가 있지만(~/.claude/.../memory/), cli-claw 고유의 기억(사용자 선호도, 과거 작업 결과, 의사결정 이력)은 세션이 끝나면 사라진다.

OpenClaw의 `memory_search` / `memory_get` 도구를 참조하되, cli-claw는 **스킬 기반**으로 구현.

---

## 아키텍처: 2단계 접근

```
Phase A: grep 기반 (코드 ~200줄, 임베딩 없음)
    ↓
Phase B: 임베딩 추가 (벡터 검색 업그레이드)
```

---

## Phase A — grep 기반 메모리 (먼저)

### 핵심 아이디어

> AI가 **구조화된 마크다운 파일**을 `~/.cli-claw/memory/`에 작성하고,
> grep으로 빠르게 검색하면 임베딩 없이도 충분한 기억 시스템이 된다.

### 메모리 디렉토리 구조

```
~/.cli-claw/memory/
├── MEMORY.md              ← 핵심 기억 (상시 참조)
├── preferences.md         ← 사용자 선호도
├── decisions.md           ← 주요 의사결정 기록
├── people.md              ← 사람/팀 메모
├── projects/              ← 프로젝트별 메모
│   ├── cli-claw.md
│   └── claw-lite.md
└── daily/                 ← 날짜별 자동 기록
    ├── 2026-02-23.md
    └── 2026-02-24.md
```

### MEMORY.md 포맷 (OpenClaw 참조)

```markdown
# Memory

## User Preferences
- 기본 CLI: codex
- 언어: 한국어 (기술 용어는 영어)
- 커밋 포맷: [agent] type: description
- 문서 스타일: narrative-first (한국어)

## Key Decisions
- 2026-02-23: browser는 playwright-core + CDP 방식 채택
- 2026-02-23: 스킬 분류는 2×3 matrix (Codex/OpenClaw × Active/Ref/Delete)

## Active Projects
- cli-claw: AI CLI wrapper (Phase 9까지 완료)
- claw-lite: 멀티 에이전트 오케스트레이터
```

### 시스템 프롬프트 주입

`src/prompt.js`의 A1_CONTENT에 추가:

```
## Long-term Memory (MANDATORY)

You have persistent memory stored in ~/.cli-claw/memory/.
- MEMORY.md contains core knowledge. ALWAYS read it at the start of a conversation.
- Before answering questions about past decisions, preferences, or people: search memory first.
- After important decisions or user preferences are revealed: save to memory.
- Use `cli-claw memory` commands for search/save operations.

### Memory Commands
cli-claw memory search <query>       # grep 기반 검색
cli-claw memory save <file> <content> # 파일에 추가
cli-claw memory read <file>           # 파일 읽기
cli-claw memory list                  # 파일 목록
```

### CLI 구현

#### [NEW] `src/memory.js` (~100줄)

```js
import { CLAW_HOME } from './config.js';
import { join } from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const MEMORY_DIR = join(CLAW_HOME, 'memory');

export function ensureMemoryDir() {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    // 초기 MEMORY.md 생성
    const memPath = join(MEMORY_DIR, 'MEMORY.md');
    if (!fs.existsSync(memPath)) {
        fs.writeFileSync(memPath, '# Memory\n\n## User Preferences\n\n## Key Decisions\n\n## Active Projects\n');
    }
}

export function search(query) {
    // grep -rni (재귀, 줄번호, 대소문자 무시) + 컨텍스트 3줄
    try {
        const result = execSync(
            `grep -rni --include="*.md" -C 3 "${query}" "${MEMORY_DIR}"`,
            { encoding: 'utf8', timeout: 5000 }
        );
        return result;
    } catch {
        return '(no results)';
    }
}

export function save(filename, content) {
    const filepath = join(MEMORY_DIR, filename);
    fs.mkdirSync(join(filepath, '..'), { recursive: true });
    fs.appendFileSync(filepath, '\n' + content + '\n');
    return filepath;
}

export function read(filename, opts = {}) {
    const filepath = join(MEMORY_DIR, filename);
    if (!fs.existsSync(filepath)) return null;
    const content = fs.readFileSync(filepath, 'utf8');
    if (opts.lines) {
        const [from, to] = opts.lines.split('-').map(Number);
        return content.split('\n').slice(from - 1, to).join('\n');
    }
    return content;
}

export function list() {
    if (!fs.existsSync(MEMORY_DIR)) return [];
    const files = [];
    function walk(dir, prefix = '') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(join(dir, entry.name), prefix + entry.name + '/');
            else if (entry.name.endsWith('.md')) files.push(prefix + entry.name);
        }
    }
    walk(MEMORY_DIR);
    return files;
}

// 자동 기록: 대화 요약 → daily/YYYY-MM-DD.md
export function appendDaily(content) {
    const date = new Date().toISOString().slice(0, 10);
    const filepath = join(MEMORY_DIR, 'daily', `${date}.md`);
    fs.mkdirSync(join(MEMORY_DIR, 'daily'), { recursive: true });
    fs.appendFileSync(filepath, `\n---\n${new Date().toISOString()}\n${content}\n`);
    return filepath;
}
```

#### [NEW] `bin/commands/memory.js` (~60줄)

```
cli-claw memory search <query>                # grep 검색
cli-claw memory save <file> "content"          # 파일에 추가
cli-claw memory read <file> [--lines 1-10]     # 파일 읽기
cli-claw memory list                           # 파일 목록
cli-claw memory init                           # 초기화 (MEMORY.md 생성)
```

#### [NEW] `skills_ref/memory/SKILL.md` (OPENCLAW_ACTIVE 자동 활성화)

```markdown
---
name: memory
description: "Persistent long-term memory across sessions. Search, save, and organize knowledge in structured markdown files."
metadata:
  openclaw:
    emoji: "🧠"
    requires: null
    install: null
---

# Long-term Memory

Persistent memory system using structured markdown files in `~/.cli-claw/memory/`.

## RULES (MANDATORY)

1. **Start of conversation**: Always run `cli-claw memory read MEMORY.md` to load core knowledge.
2. **Before answering about past work/decisions/preferences**: Run `cli-claw memory search <keywords>` first.
3. **After learning user preferences or making important decisions**: Save immediately.
4. **Never guess**: If memory search returns nothing, say "I don't have a record of that."

## Commands

### Search (grep-based, fast)
```bash
cli-claw memory search "keyword"           # Search all memory files
cli-claw memory search "user prefers"       # Find preferences
cli-claw memory search "2026-02"            # Find by date
```

### Read
```bash
cli-claw memory read MEMORY.md             # Core memory (always read first)
cli-claw memory read preferences.md        # User preferences
cli-claw memory read decisions.md          # Past decisions
cli-claw memory read projects/cli-claw.md  # Project-specific
cli-claw memory read MEMORY.md --lines 1-20  # Partial read
```

### Save
```bash
# Append to existing file
cli-claw memory save preferences.md "- Prefers dark mode for all UIs"
cli-claw memory save decisions.md "- 2026-02-23: Adopted CDP for browser control"
cli-claw memory save projects/cli-claw.md "## Phase 9 complete: auto-deps"

# Create new topic file
cli-claw memory save people.md "## Jun\n- Project owner\n- Prefers Korean UI, English code"
```

### List & Init
```bash
cli-claw memory list                       # Show all memory files
cli-claw memory init                       # Create default structure
```

## File Organization

| File                 | Purpose                                         | When to update               |
| -------------------- | ----------------------------------------------- | ---------------------------- |
| `MEMORY.md`          | Core: top-level summary of everything important | Every session, keep concise  |
| `preferences.md`     | User preferences, habits, tool choices          | When user states preferences |
| `decisions.md`       | Key technical/design decisions with dates       | After important choices      |
| `people.md`          | People, teams, contacts                         | When mentioned               |
| `projects/<name>.md` | Per-project notes                               | During project work          |
| `daily/<date>.md`    | Auto-generated session logs                     | Automatic (system writes)    |

## Workflows

### New Conversation
1. `cli-claw memory read MEMORY.md`
2. Greet user with awareness of their context
3. If task relates to known project → read that project file

### User Mentions a Preference
1. Acknowledge: "I'll remember that."
2. `cli-claw memory save preferences.md "- <preference>"`
3. If core enough → also update MEMORY.md

### User Asks "Do you remember...?"
1. `cli-claw memory search "<keywords>"`
2. If found → quote the memory with source file
3. If not found → "I don't have a record of that. Would you like me to save it?"

### End of Important Session
1. Summarize key outcomes
2. Save decisions: `cli-claw memory save decisions.md "- <date>: <decision>"`
3. Update MEMORY.md if project status changed
```

### 프롬프트 주입 — `src/prompt.js` A1_CONTENT에

```js
## Long-term Memory (MANDATORY)

You have persistent memory at ~/.cli-claw/memory/.
- At conversation start: ALWAYS read MEMORY.md first.
- Before answering about past decisions, preferences, people: search memory.
- After important decisions or preferences: save to memory immediately.
- Refer to the memory skill for full command reference.

${memoryContent ? `### Current Memory\n${memoryContent}` : ''}
```

> `memoryContent`는 MEMORY.md를 읽어서 1000자 이내로 잘라서 주입.
> 이렇게 하면 AI가 매 세션 시작 시 MEMORY.md를 CLI로 읽지 않아도 기본 기억이 있음.

### MEMORY.md 프롬프트 자동 주입 구현

```js
// src/prompt.js에 추가
function loadMemoryContent() {
    const memPath = join(CLAW_HOME, 'memory', 'MEMORY.md');
    if (!fs.existsSync(memPath)) return '';
    const content = fs.readFileSync(memPath, 'utf8');
    return content.length > 1000 ? content.slice(0, 1000) + '\n...(truncated)' : content;
}
```

---

## Phase B — 임베딩 업그레이드

### Phase A가 안정화된 후 추가

### 임베딩 방법 후보

| 방법                      | 장점                         | 단점                            |
| ------------------------- | ---------------------------- | ------------------------------- |
| **Gemini Embedding API**  | 품질 좋음, API key 이미 있음 | API 호출 비용, 네트워크 필요    |
| **Ollama (로컬)**         | 무료, 오프라인               | 모델 다운로드 필요, 메모리 사용 |
| **기존 markdown-rag MCP** | 이미 설정됨                  | cli-claw 서버와 별도, 의존 관계 |
| **TF.js (in-process)**    | Node.js 내장, 의존 0         | 품질 낮음, 초기 로딩 느림       |

### 추천: Gemini Embedding API

```js
// Phase B에서 추가
const EMBED_API = 'https://generativelanguage.googleapis.com/v1beta';

async function embed(text, apiKey) {
    const resp = await fetch(
        `${EMBED_API}/models/text-embedding-004:embedContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: { parts: [{ text }] },
            }),
        }
    );
    const data = await resp.json();
    return data.embedding.values; // float[]
}
```

저장: `~/.cli-claw/memory/.embeddings.json` (파일 → 벡터 매핑)

검색 흐름:
```
query → embed(query) → cosine similarity → top-K 결과 → grep으로 컨텍스트 확장
```

### Phase B 구현 시 변경

```
src/memory.js에 추가:
- embedChunk(text): Gemini API 호출
- indexFile(filepath): 파일 → 청크 → 임베딩 → 저장
- semanticSearch(query, k): 코사인 유사도 검색
- 결과를 grep 결과와 병합 (hybrid search)
```

---

## 체크리스트

### Phase A: grep 기반 메모리
- [ ] `src/memory.js` — search/save/read/list/appendDaily
- [ ] `bin/commands/memory.js` — CLI 서브커맨드
- [ ] `skills_ref/memory/SKILL.md` — AI 사용법
- [ ] `src/prompt.js` — Memory 섹션 + MEMORY.md 자동 주입
- [ ] `server.js` — `/api/memory-search`, `/api/memory-save`
- [ ] `bin/cli-claw.js`에 memory case
- [ ] `registry.json`에 memory 추가
- [ ] 자동 일일 기록 (daily/YYYY-MM-DD.md) 연동

### Phase B: 임베딩 (Phase A 안정화 후)
- [ ] Gemini Embedding API 연동
- [ ] 청크 분할 + 임베딩 저장
- [ ] 코사인 유사도 검색
- [ ] hybrid search (grep + 벡터)
- [ ] 자동 재인덱싱 (파일 변경 시)
