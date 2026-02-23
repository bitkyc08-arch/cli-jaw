# Phase 11.1: 서브에이전트 프롬프트에 스킬/브라우저 주입

## 문제

`distributeAndWait()`에서 서브에이전트를 spawn할 때 **하드코딩된 4줄 sysPrompt**만 전달됨.
결과적으로 서브에이전트는:

- Active Skills / Available Skills 목록을 모름
- `cli-claw browser` 명령어 사용법을 모름
- `cli-claw memory` 사용법을 모름
- A-1.md의 핵심 규칙을 모름

기획 에이전트(planning)가 task에 CLI 명령어를 구체적으로 넣어줘야만 동작 → 기획 품질에 지나치게 의존.

## 결정: 동적 불러오기 (하드코딩 ❌)

### 이유

| 기준                 | 하드코딩         | 불러오기(`prompt.js`) |
| -------------------- | ---------------- | --------------------- |
| 스킬 목록 변동       | 수동 동기화 필요 | 자동 반영 ✅           |
| 브라우저/메모리 확장 | 매번 수정        | 자동 포함 ✅           |
| 토큰 비용            | 낮음 (고정)      | 조절 가능             |
| 유지보수             | 두 곳 관리       | 한 곳 (`prompt.js`)   |

→ **`prompt.js`에 경량 서브에이전트 프롬프트 생성 함수를 추가**하고, `orchestrator.js`에서 호출.

## 설계

### 1. `prompt.js`에 `getSubAgentPrompt(emp)` 추가

```js
export function getSubAgentPrompt(emp) {
    let prompt = `# ${emp.name}\n역할: ${emp.role || '범용 개발자'}\n`;
    
    // ─── 핵심 규칙 (고정)
    prompt += `\n## 규칙\n`;
    prompt += `- 주어진 작업을 직접 실행하고 결과를 보고하세요\n`;
    prompt += `- JSON subtask 출력 금지 (당신은 실행자이지 기획자가 아닙니다)\n`;
    prompt += `- 작업 결과를 자연어로 간결하게 보고하세요\n`;
    prompt += `- 사용자 언어로 응답하세요\n`;
    
    // ─── 브라우저 명령어 (A-1.md에서 추출)
    prompt += `\n## Browser Control\n`;
    prompt += `웹 작업 시 \`cli-claw browser\` 명령어 사용 (snapshot → act → snapshot → verify).\n`;
    prompt += `시작: \`cli-claw browser start\`, 스냅샷: \`cli-claw browser snapshot\`\n`;
    
    // ─── 스킬 목록 (동적 로딩)
    const activeSkills = loadActiveSkills();
    if (activeSkills.length > 0) {
        prompt += `\n## Active Skills (${activeSkills.length})\n`;
        for (const s of activeSkills) {
            prompt += `- ${s.name} (${s.id})\n`;
        }
    }
    
    // ─── 메모리 명령어
    prompt += `\n## Memory\n`;
    prompt += `장기 기억: \`cli-claw memory search/read/save\` 명령어 사용.\n`;
    
    return prompt;
}
```

### 2. `orchestrator.js` → `distributeAndWait()` 수정

```diff
-const sysPrompt = `당신은 "${emp.name}" 입니다.
-역할: ${emp.role || '범용 개발자'}
-...`;
+const sysPrompt = getSubAgentPrompt(emp);
```

import 추가:
```diff
-import { getSystemPrompt } from './prompt.js';
+import { getSystemPrompt, getSubAgentPrompt } from './prompt.js';
```

## 범위

| 변경 파일             | 내용                                              |
| --------------------- | ------------------------------------------------- |
| `src/prompt.js`       | `getSubAgentPrompt(emp)` 함수 추가                |
| `src/orchestrator.js` | `distributeAndWait()`에서 호출 변경 + import 추가 |

## 프롬프트 분리 원칙

서브에이전트는 **실행자**이지 기획자가 아님. 오케스트레이션 규칙이 포함되면 서브에이전트가 **다시 JSON subtask를 출력 → 재귀 오케스트레이션 루프** 발생.

따라서 `getSystemPrompt()`를 통째로 주입하면 안 되고, **실행에 필요한 도구 정보만 선별 주입**.

| 섹션                   | 메인 | 서브         | 제외 이유                    |
| ---------------------- | ---- | ------------ | ---------------------------- |
| A-1 전체               | ✅    | ❌ (핵심만)   | 오케스트레이션 트리거 방지   |
| A-2 유저 설정          | ✅    | ❌            | 실행에 불필요                |
| 메모리 히스토리        | ✅    | ❌ (명령어만) | 컨텍스트 오염 방지           |
| 오케스트레이션 규칙    | ✅    | ❌ **금지**   | ⚠️ **재귀 루프 원인**         |
| 브라우저 명령어        | ✅    | ✅ (요약)     | 실행에 필요                  |
| 스킬 목록              | ✅    | ✅ (이름만)   | 실행에 필요                  |
| Available Skills (ref) | ✅    | ❌            | 미설치 스킬에 의존하면 안 됨 |
| Heartbeat              | ✅    | ❌            | 오케스트레이션 트리거 방지   |

## 검증

1. `cli-claw serve` 후 브라우저 관련 작업을 서브에이전트에 배분
2. 서브에이전트가 `cli-claw browser` 명령어를 사용하는지 확인
3. 콘솔 로그에서 서브에이전트의 sysPrompt 내용 확인 가능 (`--verbose`)
