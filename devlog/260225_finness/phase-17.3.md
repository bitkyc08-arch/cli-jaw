# Phase 17.3 — Employee 명칭 통일 (subagent → employee)

> 목표: "subagent/서브에이전트" → "employee/직원" 명칭 통일  
> 프롬프트에는 `employee (sub-agent)` 형태로 첫 등장 시 병기, 이후 employee만 사용

---

## 감사 결과

### 코드 (함수/변수명)

| 파일 | 줄 | 현재 | 변경 |
|------|---|------|------|
| `prompt.js` L391 | 주석 | `// ─── Sub-Agent Prompt (orchestration-free)` | `// ─── Employee Prompt (orchestration-free)` |
| `prompt.js` L393 | 함수 | `export function getSubAgentPrompt(emp)` | `export function getEmployeePrompt(emp)` |
| `prompt.js` L438 | 주석 | `// ─── Sub-Agent Prompt v2 (orchestration phase-aware)` | `// ─── Employee Prompt v2 (orchestration phase-aware)` |
| `prompt.js` L440 | 함수 | `export function getSubAgentPromptV2(emp, role, phase)` | `export function getEmployeePromptV2(emp, role, phase)` |
| `prompt.js` L441 | 내부 호출 | `let prompt = getSubAgentPrompt(emp)` | `let prompt = getEmployeePrompt(emp)` |
| `orchestrator.js` L5 | import | `import { getSubAgentPromptV2 }` | `import { getEmployeePromptV2 }` |
| `orchestrator.js` L309 | 호출 | `getSubAgentPromptV2(emp, ...)` | `getEmployeePromptV2(emp, ...)` |

### 프롬프트 텍스트 (에이전트가 읽는 문자열)

| 파일 | 현재 | 변경 |
|------|------|------|
| `prompt.js` Orchestration 섹션 L302 | `external employees (separate CLI processes)` | 이미 employee ✅ |
| `prompt.js` getSubAgentPrompt 내 규칙 | `You are an employee (sub-agent) of the main...` | 첫 줄에 `(sub-agent)` 병기 확인 |

### 문서 (devlog/str_func/)

| 파일 | 줄 | 현재 | 변경 |
|------|---|------|------|
| `str_func.md` L33 | 트리 | `서브에이전트 v2` | `직원(employee) 프롬프트 v2` |
| `str_func.md` L216 | 주의 | `Sub-Agent는 perCli` | `Employee는 perCli` |
| `str_func.md` L248 | 서브문서 | `서브에이전트 규칙` | `직원(employee) 규칙` |
| `str_func.md` L254 | 아카이브 | `서브에이전트프롬프트` | (폴더명 그대로 유지) |
| `agent_spawn.md` L57-58 | 설명 | `sub-agent도 참조` | `employee도 참조` |
| `agent_spawn.md` L218-219 | 함수 테이블 | `getSubAgentPrompt` | `getEmployeePrompt` |
| `prompt_flow.md` L270 | 섹션 제목 | `직원(Sub-Agent) 프롬프트` | `직원(Employee) 프롬프트` |
| `prompt_flow.md` L275,286,313 | 다이어그램/코드 | `getSubAgentPrompt` | `getEmployeePrompt` |
| `prompt_basic_B.md` | 서브문서 설명 | `서브에이전트 레퍼런스` | `직원(employee) 레퍼런스` |
| `frontend.md` L32,68 | 모듈 설명 | `서브에이전트 CRUD` | `직원(employee) CRUD` |
| `frontend.md` L116 | 타임라인 | `서브에이전트` | `직원(employee)` |

---

## 변경 방침

1. **함수명**: `getSubAgentPrompt` → `getEmployeePrompt`, `getSubAgentPromptV2` → `getEmployeePromptV2`
2. **프롬프트 텍스트**: 첫 등장 시 `employee (sub-agent)` 병기, 이후 employee만
3. **한국어 문서**: `서브에이전트` → `직원(employee)`
4. **폴더명/아카이브**: 기존 폴더명(`260223_서브에이전트프롬프트`)은 그대로 (히스토리 보존)
5. **테스트**: 함수명 변경됐으므로 import 참조 확인 필요

---

## 영향 범위

- **소스 코드**: `prompt.js` (5줄), `orchestrator.js` (2줄)
- **문서**: `str_func.md` (3줄), `agent_spawn.md` (4줄), `prompt_flow.md` (4줄), `frontend.md` (3줄), `prompt_basic_B.md` (1줄)
- **테스트**: 0건 (함수 직접 import 없음)
- **외부 영향**: 없음 (내부 함수, API 미노출)
