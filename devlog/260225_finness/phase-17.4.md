# Phase 17.4 — HTML 고정 영어 문자열 한글화 (i18n 확장)

> 목표: index.html에 하드코딩된 영어 문자열 → `data-i18n` 속성 + locale JSON 키 추가
> 기존 시스템: `public/locales/ko.json` (149키) + `en.json`, `applyI18n()` 자동 스캔

---

## 현재 상태

### 이미 i18n 처리된 것 ✅
- 시간 옵션 (`time.1m`, `time.5m`, …)
- 상태 배지 (`status.responding`)
- 채팅 입력 (`input.placeholder`)
- 스킬 필터 (`skill.filter.*`)
- 버튼 (`btn.save`, `btn.cancel`, `btn.attach`, `btn.editPrompt`)
- 하트비트 (`hb.add`)
- 드래그 (`drag.drop`)

### 하드코딩 영어 — 변경 대상

#### 좌측 사이드바 (section-title)

| 줄 | 현재 | i18n 키 | ko | en |
|---|------|---------|---|---|
| L40 | `Status` | `sidebar.status` | 상태 | Status |
| L45 | `Memory` | `sidebar.memory` | 메모리 | Memory |
| L50 | `Stats` | `sidebar.stats` | 통계 | Stats |
| L56 | `CLI STATUS` | `sidebar.cliStatus` | CLI 상태 | CLI STATUS |
| L74 | `Agent Name` | `sidebar.agentName` | 에이전트 이름 | Agent Name |

#### 우측 사이드바 (탭/라벨)

| 줄 | 현재 | i18n 키 | ko | en |
|---|------|---------|---|---|
| L123 | `Agents` | `tab.agents` | 에이전트 | Agents |
| L124 | `Skills` | `tab.skills` | 스킬 | Skills |
| L125 | `Settings` | `tab.settings` | 설정 | Settings |
| L128 | `Save` | `btn.saveSettings` | 저장 | Save |
| L134 | `Active CLI` | `label.activeCli` | 활성 CLI | Active CLI |
| L145 | `Model` | `label.model` | 모델 | Model |
| L149 | `Effort` | `label.effort` | 추론 강도 | Effort |
| L159 | `Permissions` | `label.permissions` | 권한 | Permissions |
| L167 | `Working Directory` | `label.workingDir` | 작업 디렉토리 | Working Directory |
| L174 | `Employees` | `sidebar.employees` | 직원 | Employees |
| L175 | `+ Add` | `btn.addEmployee` | + 추가 | + Add |
| L179 | `No agents yet` | `emp.empty` | 직원이 없습니다 | No employees yet |

#### Settings 탭 내부

| 줄 | 현재 | i18n 키 | ko | en |
|---|------|---------|---|---|
| L211 | `Enabled` | `label.enabled` | 활성화 | Enabled |
| L213 | `Off` | `btn.off` | 끔 | Off |
| L214 | `On` | `btn.on` | 켬 | On |
| L218 | `Bot Token` | `label.botToken` | 봇 토큰 | Bot Token |
| L223 | `Allowed Chat IDs` | `label.chatIds` | 허용 채팅 ID | Allowed Chat IDs |

#### 모달/기타

| 줄 | 현재 | i18n 키 | ko | en |
|---|------|---------|---|---|
| L341 | `System Prompt (A-2)` | `modal.promptTitle` | 시스템 프롬프트 (A-2) | System Prompt (A-2) |
| L358 | `💓 Heartbeat Jobs` | `modal.heartbeatTitle` | 💓 하트비트 작업 | 💓 Heartbeat Jobs |
| L373 | `🧠 Memory` | `modal.memoryTitle` | 🧠 메모리 | 🧠 Memory |
| L387 | `Enabled` (메모리) | `label.enabled` | (재사용) | (재사용) |
| L393 | `Flush Every` | `label.flushEvery` | 정리 주기 | Flush Every |

#### perCli 복제 라벨 (Model/Effort × 5개 CLI)

`Model`, `Effort` 라벨이 각 CLI 섹션에 반복 (L233,239,251,257,270,280,286,300,306). `data-i18n="label.model"` / `data-i18n="label.effort"` → `AllowMultiple` 적용.

---

## 구현 계획

### 1. `public/locales/ko.json` — 새 키 추가 (~25개)

```json
{
    "sidebar.status": "상태",
    "sidebar.memory": "메모리",
    "sidebar.stats": "통계",
    "sidebar.cliStatus": "CLI 상태",
    "sidebar.agentName": "에이전트 이름",
    "sidebar.employees": "직원",
    "tab.agents": "에이전트",
    "tab.skills": "스킬",
    "tab.settings": "설정",
    "btn.saveSettings": "저장",
    "btn.addEmployee": "+ 추가",
    "btn.off": "끔",
    "btn.on": "켬",
    "label.activeCli": "활성 CLI",
    "label.model": "모델",
    "label.effort": "추론 강도",
    "label.permissions": "권한",
    "label.workingDir": "작업 디렉토리",
    "label.enabled": "활성화",
    "label.botToken": "봇 토큰",
    "label.chatIds": "허용 채팅 ID",
    "label.flushEvery": "정리 주기",
    "emp.empty": "직원이 없습니다",
    "modal.promptTitle": "시스템 프롬프트 (A-2)",
    "modal.heartbeatTitle": "💓 하트비트 작업",
    "modal.memoryTitle": "🧠 메모리"
}
```

### 2. `public/locales/en.json` — 새 키 추가 (같은 25개, 영어 값)

### 3. `public/index.html` — `data-i18n` 속성 추가 (~30줄)

```diff
-<div class="section-title">Status</div>
+<div class="section-title" data-i18n="sidebar.status">상태</div>

-<label>Active CLI</label>
+<label data-i18n="label.activeCli">활성 CLI</label>

-<label>Model</label>
+<label data-i18n="label.model">모델</label>
```

> `<label>Model</label>`은 5개 CLI 섹션에 반복 → `AllowMultiple` 사용

---

## 충돌 분석

| 파일 | 내 변경 | 다른 에이전트 | 충돌 |
|------|--------|-------------|------|
| `ko.json` | 신규 키 추가 (파일 끝) | 변경 없음 | ✅ 없음 |
| `en.json` | 신규 키 추가 (파일 끝) | 변경 없음 | ✅ 없음 |
| `index.html` | `data-i18n` 속성 + 기본값 교체 | 방금 nav/aside/aria 변경 (다른 줄) | ⚠️ 낮음 (같은 줄 일부 겹침 가능) |

---

## 영향 범위

- **파일**: `ko.json` (+25키), `en.json` (+25키), `index.html` (~30줄 속성 추가)
- **테스트**: 기존 i18n 테스트 영향 없음 (신규 키만)
- **런타임**: `applyI18n()` 자동 스캔 → 추가 코드 불필요
