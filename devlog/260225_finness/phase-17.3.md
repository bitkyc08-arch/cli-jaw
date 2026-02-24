# Phase 17.3 — Employee 명칭 통일 (subagent → employee)

> 목표: "subagent/서브에이전트" → "employee/직원" 명칭 통일  
> 프롬프트에는 `employee (sub-agent)` 형태로 첫 등장 시 병기, 이후 employee만 사용

---

## 충돌 분석

| 파일 | 내 변경 위치 | 다른 에이전트 변경 위치 | 충돌 가능성 |
|------|------------|---------------------|------------|
| `prompt.js` | L391,393,438,440,441 (함수명/주석) | 변경 없음 | ✅ 없음 |
| `orchestrator.js` | L5,309 (import/call) | 변경 없음 | ✅ 없음 |
| `str_func.md` | L33 (서브에이전트→직원), L216 (Sub-Agent), L248 (서브에이전트) | L14,22,25,26,28,36,51,69,80 (라인 수만) | ✅ 없음 (다른 줄) |
| `agent_spawn.md` | L57-58,218-219 (sub-agent→employee) | 변경 없음 | ✅ 없음 |
| `prompt_flow.md` | L270,275,286,313 (Sub-Agent→Employee) | 변경 없음 | ✅ 없음 |
| `frontend.md` | L32,68,116 (서브에이전트→직원) | 변경 없음 | ✅ 없음 |
| `prompt_basic_B.md` | 서브문서 설명 (서브에이전트) | 변경 없음 | ✅ 없음 |
| `verify-counts.sh` | 변경 없음 (subagent 미포함) | 변경 없음 | ✅ 없음 |

> **결론: 충돌 가능성 0.** 모든 변경이 서로 다른 줄/파일.

---

## 변경 1: `src/prompt.js` (5줄)

```diff
-// ─── Sub-Agent Prompt (orchestration-free) ───────────
+// ─── Employee Prompt (orchestration-free) ────────────

-export function getSubAgentPrompt(emp) {
+export function getEmployeePrompt(emp) {
     let prompt = `# ${emp.name}\nRole: ${emp.role || 'general developer'}\n`;
     // ... (내부 변경 없음)
     return prompt;
 }

-// ─── Sub-Agent Prompt v2 (orchestration phase-aware) ─
+// ─── Employee Prompt v2 (orchestration phase-aware) ──

-export function getSubAgentPromptV2(emp, role, currentPhase) {
-    let prompt = getSubAgentPrompt(emp);
+export function getEmployeePromptV2(emp, role, currentPhase) {
+    let prompt = getEmployeePrompt(emp);
```

---

## 변경 2: `src/orchestrator.js` (2줄)

```diff
-import { getSubAgentPromptV2 } from './prompt.js';
+import { getEmployeePromptV2 } from './prompt.js';

 // ... L309:
-        const sysPrompt = getSubAgentPromptV2(emp, ap.role, ap.currentPhase);
+        const sysPrompt = getEmployeePromptV2(emp, ap.role, ap.currentPhase);
```

---

## 변경 3: `devlog/str_func.md` (3줄)

```diff
 # L33 (현재 HEAD 기준):
-│   ├── prompt.js  ← ... + 서브에이전트 v2 + ...
+│   ├── prompt.js  ← ... + 직원(employee) 프롬프트 v2 + ...

 # L216:
-22. **activeOverrides**: ... Sub-Agent는 `perCli`만 참조
+22. **activeOverrides**: ... Employee는 `perCli`만 참조

 # L248:
-| [📄 prompt_basic_B.md](...) | ... 서브에이전트 규칙, 직원 프롬프트, 위임 정책) | 서브에이전트 레퍼런스 |
+| [📄 prompt_basic_B.md](...) | ... 직원(employee) 규칙, 직원 프롬프트, 위임 정책) | 직원(employee) 레퍼런스 |
```

> ⚠️ L254 `260223_서브에이전트프롬프트` 폴더명 → 히스토리 보존으로 변경 안 함

---

## 변경 4: `devlog/str_func/agent_spawn.md` (4줄)

```diff
 # L57-58:
-- perCli: 사이드바 CLI별 설정 (sub-agent도 참조)
-- Sub-Agent(opts.agentId || opts.internal): activeOverrides 무시 → perCli만
+- perCli: 사이드바 CLI별 설정 (employee도 참조)
+- Employee(opts.agentId || opts.internal): activeOverrides 무시 → perCli만

 # L218-219 (함수 테이블):
-| `getSubAgentPrompt(emp)`                | 실행자용 경량 프롬프트 ...
-| `getSubAgentPromptV2(emp, role, phase)` | **v2** — dev 스킬 + ...
+| `getEmployeePrompt(emp)`                | 실행자용 경량 프롬프트 ...
+| `getEmployeePromptV2(emp, role, phase)` | **v2** — dev 스킬 + ...
```

---

## 변경 5: `devlog/str_func/prompt_flow.md` (4줄)

```diff
 # L270:
-## Layer 4 — 직원(Sub-Agent) 프롬프트
+## Layer 4 — 직원(Employee) 프롬프트

 # L275 (mermaid):
-    ORC -->|"직원별 spawn"| SUB["getSubAgentPrompt(emp)"]
+    ORC -->|"직원별 spawn"| SUB["getEmployeePrompt(emp)"]

 # L286 (표):
-| 항목 | 메인 에이전트 | 직원 (Sub-Agent) |
+| 항목 | 메인 에이전트 | 직원 (Employee) |

 # L313 (코드 예시):
-     sysPrompt: getSubAgentPrompt(emp)  ← 경량 프롬프트
+     sysPrompt: getEmployeePrompt(emp)  ← 경량 프롬프트
```

---

## 변경 6: `devlog/str_func/frontend.md` (3줄)

```diff
 # L32:
-        ├── employees.js  ← 서브에이전트 CRUD (CSS dot, 이모지 없음) (106L)
+        ├── employees.js  ← 직원(employee) CRUD (CSS dot, 이모지 없음) (106L)

 # L68:
-| `employees.js` | 서브에이전트 CRUD (CSS dot) | 106 |
+| `employees.js` | 직원(employee) CRUD (CSS dot) | 106 |

 # L116:
-| 6.1 | 레이아웃 리팩터 + 이모지 정리 (탭, 서브에이전트, ROLE_PRESETS) |
+| 6.1 | 레이아웃 리팩터 + 이모지 정리 (탭, 직원, ROLE_PRESETS) |
```

---

## 변경 7: verify-counts.sh

변경 **없음**. subagent/서브에이전트 미포함.

---

## 요약

| 카테고리 | 파일 | 변경 줄 수 |
|---------|------|-----------|
| 코드 (함수명) | `prompt.js` | 5줄 |
| 코드 (참조) | `orchestrator.js` | 2줄 |
| 문서 | `str_func.md` | 3줄 |
| 문서 | `agent_spawn.md` | 4줄 |
| 문서 | `prompt_flow.md` | 4줄 |
| 문서 | `frontend.md` | 3줄 |
| **합계** | **6 파일** | **21줄** |
| 충돌 가능성 | | **0** |
