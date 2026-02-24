# Phase 3: UX + 연속성

> **의존**: Phase 2 (`orchestrator.js` v2)
> **검증일**: 2026-02-24
> **산출물**: 프런트엔드 행렬 표시, "이어서 해줘" 연속성, 새 API 엔드포인트

---

## 3-A: 프런트엔드 행렬 표시

```mermaid
graph TD
    WS["WebSocket 메시지"] --> UI["프런트엔드"]
    
    subgraph "새 이벤트 타입"
        E1["worklog_created"]
        E2["round_start + agentPhases"]
        E3["round_done + agentPhases"]
    end
    
    UI --> MATRIX["Agent Status Matrix<br/>(실시간 행렬 표)"]
    UI --> PHASE["Phase 뱃지<br/>(각 agent 카드에 현재 phase 표시)"]
    UI --> WL["Worklog 링크<br/>(현재 worklog 파일 경로)"]
```

**bus.js**: 기존 브로드캐스트에 `agentPhases` 배열 추가로 전달.

**프런트엔드**: `employees.js`의 각 agent 카드에 phase 뱃지 표시:

```javascript
// public/js/features/employees.js 확장
function renderPhaseBadge(phase, phaseLabel) {
  const colors = { 1: '#60a5fa', 2: '#a78bfa', 3: '#34d399', 4: '#fbbf24', 5: '#f472b6' };
  return `<span style="background:${colors[phase]};color:#000;padding:1px 6px;border-radius:9px;font-size:10px">${phaseLabel}</span>`;
}
```

---

## 3-B: "이어서 해줘" 연속성

```mermaid
sequenceDiagram
    participant U as User
    participant O as orchestrate()
    participant WL as worklog.js

    U->>O: "이어서 해줘"
    O->>WL: readLatestWorklog()
    WL-->>O: { path, content, agentPhases }
    
    Note over O: content에서 미완료 agent 파싱
    Note over O: agentPhases 복원
    
    O->>O: 기존 round loop 재진입
    Note over O: round = 1부터 다시 (이전 worklog 참조)
```

```javascript
// orchestrator.js에 추가
export async function orchestrateContinue() {
  const latest = readLatestWorklog();
  if (!latest) {
    broadcast('orchestrate_done', { text: '이어갈 worklog가 없습니다.' });
    return;
  }

  const pending = parseWorklogPending(latest.content);
  if (!pending.length) {
    broadcast('orchestrate_done', { text: '모든 작업이 이미 완료되었습니다.' });
    return;
  }

  const resumePrompt = `## 이어서 작업
이전 worklog를 읽고 미완료 항목을 이어서 진행하세요.

Worklog: ${latest.path}

미완료 항목:
${pending.map(p => `- ${p.agent} (${p.role}): Phase ${p.currentPhase}`).join('\n')}

subtask JSON을 출력하세요.`;

  return orchestrate(resumePrompt);
}
```

---

## 3-C: 기본 서브에이전트 5명 자동 생성

`cli-claw init` 또는 최초 실행 시 기본 서브에이전트 5명을 자동 추가.
`cli-claw employee reset`으로 기본값 재설정 가능.

| #   | 이름   | 역할     | CLI       | 목적              |
| --- | ------ | -------- | --------- | ----------------- |
| 1   | 프런트 | frontend | *default* | UI/UX 개발        |
| 2   | 백엔드 | backend  | *default* | API/서버 로직     |
| 3   | 데이터 | data     | *default* | 데이터 파이프라인 |
| 4   | 문서   | docs     | *default* | 문서화            |
| 5   | 검수   | custom   | *default* | 코드 리뷰/QA      |

> [!IMPORTANT]
> **모든 기본 에이전트는 `settings.cli` (기본 CLI)로만 세팅.**
> 사용자가 CLI를 하나만 연결했을 수 있으므로, 개별 CLI 하드코딩 금지.

```javascript
// src/config.js 또는 bin/commands/init.js
const DEFAULT_EMPLOYEES = [
  { name: '프런트', role: 'UI/UX 구현, CSS, 컴포넌트 개발' },
  { name: '백엔드', role: 'API, DB, 서버 로직 구현' },
  { name: '데이터', role: '데이터 파이프라인, 분석, ML' },
  { name: '문서',   role: '문서화, README, API docs' },
  { name: '검수',   role: '코드 리뷰, 테스트 검증, QA' },
];

function seedDefaultEmployees() {
  const cli = settings.cli;  // 전부 기본 CLI 사용
  for (const emp of DEFAULT_EMPLOYEES) {
    insertEmployee(emp.name, cli, emp.role);
  }
}

// 최초 실행: employees 비어있을 때만
if (!getEmployees().length) seedDefaultEmployees();

// reset: cli-claw employee reset → 전부 삭제 후 재생성
// deleteAllEmployees() + seedDefaultEmployees()
```

---

## 파일 변경 요약

| 파일                                        | 작업                                |
| ------------------------------------------- | ----------------------------------- |
| `public/js/features/employees.js`           | [MODIFY] phase 뱃지 표시            |
| `public/js/ws.js`                           | [MODIFY] 새 이벤트 핸들링           |
| `src/orchestrator.js`                       | [MODIFY] `orchestrateContinue` 추가 |
| `server.js` (루트)                          | [MODIFY] "이어서" API 엔드포인트    |
| `src/config.js` 또는 `bin/commands/init.js` | [MODIFY] 기본 서브에이전트 5명      |

---

## 검증된 리스크

### 🟡 MEDIUM: `parseWorklogPending` 미정의

`orchestrateContinue()`에서 사용하는 `parseWorklogPending(latest.content)` 함수가 설계에 정의 안 됨.

**해결**: `worklog.js`에 추가 구현 필요. worklog의 Agent Status Matrix 테이블을 파싱해서 `completed: false`인 agent 목록 반환:

```javascript
export function parseWorklogPending(content) {
  const lines = content.split('\n');
  const pending = [];
  let inMatrix = false;
  for (const line of lines) {
    if (line.includes('## Agent Status Matrix')) { inMatrix = true; continue; }
    if (inMatrix && line.startsWith('## ')) break;
    if (inMatrix && line.includes('⏳')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 3) {
        const phaseMatch = cols[2].match(/Phase (\d+)/);
        pending.push({ agent: cols[0], role: cols[1], currentPhase: phaseMatch ? +phaseMatch[1] : 3 });
      }
    }
  }
  return pending;
}
```

### 🟡 MEDIUM: `server.js` 경로 주의

파일 변경 요약에 `src/server.js`로 표기되어 있었지만 실제 서버 파일은 **루트 `server.js`**.

### 🟡 MEDIUM: WS 이벤트 프런트엔드 처리

새 이벤트 (`worklog_created`, `round_start`, `round_done`)를 `ws.js`에서 핸들링 추가 필요.
현재 `ws.js`에는 이 이벤트 타입이 없으므로 무시됨 → Phase 3에서 반드시 추가.

