# Phase 17.1 — 프롬프트 개선: 스킬 참조 의무화 + 직원 dispatch 정책

> Phase 17 (triage regex 문제)와 연결. 코드 변경 없이 프롬프트만으로 에이전트 행동 개선.

---

## 문제 1: 개발 시 dev 스킬 미참조

현재 `getSystemPrompt()` Skills System 섹션:
```
### Active Skills (17)
These skills are installed and triggered automatically by the CLI.
- dev (dev)
- dev-frontend (dev-frontend)
...
```

→ 에이전트에게 "이름만 알려줌". dev/SKILL.md를 **언제 읽어야 하는지** 안 알려줌.

### 수정 (prompt.js L346-351)

```diff
 if (activeSkills.length > 0) {
     prompt += `\n### Active Skills (${activeSkills.length})\n`;
-    prompt += 'These skills are installed and triggered automatically by the CLI.\n';
+    prompt += 'These skills are installed and available for reference.\n';
+    prompt += '**Development tasks**: Before writing code, ALWAYS read `~/.cli-claw/skills/dev/SKILL.md` for project conventions.\n';
+    prompt += 'For role-specific tasks, also read the relevant skill (dev-frontend, dev-backend, dev-data, dev-testing).\n';
     for (const s of activeSkills) {
         prompt += `- ${s.name} (${s.id})\n`;
     }
 }
```

---

## 문제 2: 직원 dispatch 정책 과도

현재 Orchestration System 규칙:
```
4. If the request is actionable, always output subtask JSON  ← 과도!
6. If you can answer directly, respond in natural language without JSON
```

규칙 4와 6이 **모순**. 에이전트 혼란 → 짧은 요청에도 JSON 출력 시도.

### 수정 (prompt.js L308-314)

```diff
 prompt += '\n\n### CRITICAL RULES';
 prompt += '\n1. JSON MUST be wrapped in ```json ... ``` code blocks (mandatory)';
 prompt += '\n2. Never output raw JSON without code blocks';
 prompt += '\n3. Agent name must exactly match the list above';
-prompt += '\n4. If the request is actionable, always output subtask JSON';
-prompt += '\n5. When receiving a "result report", summarize it in natural language for the user';
-prompt += '\n6. If you can answer directly, respond in natural language without JSON';
+prompt += '\n4. Dispatch employees ONLY when the task genuinely needs multiple specialists or parallel work';
+prompt += '\n5. If you can handle the task yourself, respond directly WITHOUT JSON dispatch';
+prompt += '\n6. When receiving a "result report", summarize it in natural language for the user';
+prompt += '\n7. Simple questions, single-file edits, or tasks in your expertise → handle directly';
```

---

## 요약

| 변경 | 파일 | 줄 | 효과 |
|------|------|---|------|
| 스킬 참조 의무화 | `prompt.js` L346-351 | +2줄 | 에이전트가 코딩 전 dev/SKILL.md 참조 |
| dispatch 정책 정리 | `prompt.js` L308-314 | ~4줄 교체 | 불필요한 직원 호출 방지 |
| 모순 규칙 제거 | `prompt.js` L312 | 삭제 | "항상 JSON" vs "직접 응답" 충돌 해소 |
