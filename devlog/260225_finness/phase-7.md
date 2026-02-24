# Phase 7 (finness): Web UI 다국어 지원 (i18n)

> 목표: 한/영 전환 + 언어 추가 확장 가능한 i18n 시스템

---

## 현재 상태

모든 UI 문자열이 HTML/JS에 하드코딩 (한국어·영어 혼재):
| 위치 | 예시 | 언어 |
|------|------|------|
| `index.html` | "메시지 입력...", "파일을 여기에 드랍하세요" | KO |
| `index.html` | "Status", "Memory", "Save", "Settings" | EN |
| `index.html` | "1분", "5분", "수동" | KO |
| `features/settings.js` | "시스템 프롬프트 편집", "CLI 실패 시 자동 재시도 순서" | KO |
| `features/skills.js` | "전체", "설치됨", "로딩 중..." | KO |
| `features/chat.js` | "응답 중" | KO |
| `features/heartbeat.js` | "새 하트비트 추가" | KO |
| `features/slash-commands.js` | 커맨드 설명 텍스트 | KO |

---

## 설계 방침

1. **경량 자체 구현** — 외부 라이브러리 없음 (i18next 등 불필요, 문자열 100개 미만)
2. **JSON 딕셔너리** — `public/locales/{ko,en}.json`
3. **`data-i18n` 속성** — HTML 요소에 키 바인딩
4. **JS 문자열** — `t('key')` 함수로 치환
5. **localStorage 저장** — 새로고침 후 언어 유지

---

## 작업 계획

### Step 1: 번역 딕셔너리 작성

#### [NEW] `public/locales/ko.json` (~80 키)

```json
{
  "status": "상태",
  "memory": "메모리",
  "stats": "통계",
  "messages": "메시지",
  "cli_status": "CLI 상태",
  "refresh": "새로고침",
  "interval_1m": "1분",
  "interval_5m": "5분",
  "interval_10m": "10분",
  "interval_manual": "수동",
  "clear": "/clear",
  "agents": "🤖 에이전트",
  "skills": "📦 스킬",
  "settings": "🔧 설정",
  "save": "저장",
  "active_cli": "활성 CLI",
  "model": "모델",
  "effort": "에포트",
  "permissions": "권한",
  "safe": "🔒 안전",
  "auto": "⚡ 자동",
  "working_dir": "작업 디렉토리",
  "sub_agents": "Sub Agents",
  "add": "+ 추가",
  "no_agents": "아직 에이전트 없음",
  "filter_all": "전체",
  "filter_installed": "📦 설치됨",
  "filter_productivity": "📝 생산성",
  "filter_comm": "📧 커뮤",
  "filter_dev": "🔧 개발",
  "filter_ai": "🤖 AI",
  "filter_util": "🌐 유틸",
  "filter_home": "🏠 홈",
  "filter_other": "📂 기타",
  "loading": "로딩 중...",
  "edit_prompt": "✏️ 시스템 프롬프트 편집",
  "telegram": "📬 텔레그램",
  "enabled": "활성화",
  "bot_token": "봇 토큰",
  "chat_ids": "허용 Chat IDs",
  "chat_ids_placeholder": "콤마 구분 (비워두면 전체 허용)",
  "fallback": "⚡ 폴백",
  "fallback_desc": "CLI 실패 시 자동 재시도 순서",
  "mcp_servers": "🔌 MCP 서버",
  "sync_mcp": "🔄 모든 CLI에 동기화",
  "install_mcp": "📦 전역 설치 (npm i -g)",
  "input_placeholder": "메시지 입력...",
  "drag_drop": "📎 파일을 여기에 드랍하세요",
  "responding": "🦞 응답 중",
  "cancel": "취소",
  "add_heartbeat": "+ 새 하트비트 추가",
  "idle": "⚡ idle",
  "theme_dark": "🌙 다크",
  "theme_light": "☀️ 라이트",
  "lang_ko": "🇰🇷 한국어",
  "lang_en": "🇺🇸 English"
}
```

#### [NEW] `public/locales/en.json` (~80 키)

동일 키 + 영어 값:
```json
{
  "status": "Status",
  "memory": "Memory",
  "stats": "Stats",
  "messages": "Messages",
  "cli_status": "CLI Status",
  "refresh": "Refresh",
  "interval_1m": "1 min",
  "interval_5m": "5 min",
  "interval_10m": "10 min",
  "interval_manual": "Manual",
  "input_placeholder": "Type a message...",
  "drag_drop": "📎 Drop files here",
  "responding": "🦞 Responding",
  "...": "..."
}
```

### Step 2: i18n 코어 모듈

#### [NEW] `public/js/features/i18n.js` (~60L)

| 함수 | 역할 |
|------|------|
| `initI18n()` | `localStorage.getItem('lang')` → 없으면 `navigator.language` 감지 → `loadLocale()` |
| `loadLocale(lang)` | `fetch('/locales/${lang}.json')` → 딕셔너리 캐시 |
| `t(key, params?)` | 딕셔너리 조회 + 템플릿 보간 (`{count}` → 실제 값). 키 없으면 키 자체 리턴 |
| `applyI18n()` | `document.querySelectorAll('[data-i18n]')` → `textContent = t(key)` |
| `setLang(lang)` | 딕셔너리 교체 + `applyI18n()` + localStorage 저장 |
| `getLang()` | 현재 언어 코드 리턴 |

### Step 3: HTML에 `data-i18n` 키 바인딩

#### [MODIFY] `public/index.html`

**정적 텍스트에 `data-i18n` 속성 추가:**
```diff
-<div class="section-title">Status</div>
+<div class="section-title" data-i18n="status">Status</div>

-<textarea ... placeholder="메시지 입력..."></textarea>
+<textarea ... placeholder="메시지 입력..." data-i18n-placeholder="input_placeholder"></textarea>
```

> `data-i18n` → textContent, `data-i18n-placeholder` → placeholder 속성 치환

**언어 토글 버튼** (좌측 사이드바 또는 테마 토글 옆):
```html
<button id="langToggle" class="btn-clear">🇰🇷 한국어</button>
```

### Step 4: JS 동적 문자열 치환

#### [MODIFY] `public/js/features/settings.js`
- 하드코딩 한국어 문자열 → `t('key')` 호출

#### [MODIFY] `public/js/features/skills.js`
- 필터 버튼 텍스트, "로딩 중..." → `t()` 

#### [MODIFY] `public/js/features/chat.js`
- "응답 중" → `t('responding')`

#### [MODIFY] `public/js/features/heartbeat.js`
- "새 하트비트 추가" → `t('add_heartbeat')`

#### [MODIFY] `public/js/features/slash-commands.js`
- 커맨드 설명 → `t()` 또는 딕셔너리에 커맨드 설명 키 추가

#### [MODIFY] `public/js/ui.js`
- 상태 텍스트, 레이블 등 동적 생성 문자열 → `t()`

### Step 5: main.js 통합

#### [MODIFY] `public/js/main.js`
- `import { initI18n } from './features/i18n.js'`
- `DOMContentLoaded` 시 `initI18n()` 호출
- 언어 토글 이벤트: `langToggle.onclick → setLang(nextLang)`

### Step 6: 서버 (변경 최소)

- `locales/*.json`은 정적 파일 → Express `express.static('public')` 이미 서빙 중
- 서버 측 변경 불필요

---

## 수정 대상 파일 요약

| 파일 | 변경 유형 | 비고 |
|------|----------|------|
| `public/locales/ko.json` | **NEW** | 한국어 딕셔너리 |
| `public/locales/en.json` | **NEW** | 영어 딕셔너리 |
| `public/js/features/i18n.js` | **NEW** | i18n 코어 모듈 |
| `public/index.html` | MODIFY | `data-i18n` 속성 추가 + 언어 토글 버튼 |
| `public/js/main.js` | MODIFY | `initI18n()` import + 호출 |
| `public/js/features/settings.js` | MODIFY | `t()` 치환 |
| `public/js/features/skills.js` | MODIFY | `t()` 치환 |
| `public/js/features/chat.js` | MODIFY | `t()` 치환 |
| `public/js/features/heartbeat.js` | MODIFY | `t()` 치환 |
| `public/js/features/slash-commands.js` | MODIFY | `t()` 치환 |
| `public/js/ui.js` | MODIFY | `t()` 치환 |

---

## 완료 기준

| 항목 | 조건 |
|------|------|
| 한/영 전환 | 토글 버튼 클릭 → 전체 UI 텍스트 즉시 전환 |
| 새로고침 유지 | `localStorage` 기반 언어 복원 |
| 누락 0건 | UI에 보이는 모든 정적/동적 텍스트가 딕셔너리 키로 관리됨 |
| fallback | 키 없으면 키 자체 표시 (깨짐 방지) |
| 확장성 | `public/locales/ja.json` 등 파일 추가만으로 새 언어 지원 |

---

## Phase 6 → 7 의존성

Phase 7의 `data-i18n` 바인딩은 Phase 6의 테마 토글 UI와 동일 사이드바를 수정함.
**Phase 6을 먼저 완료** 후 Phase 7 진행 권장 (충돌 회피).
테마 토글(`#themeToggle`)과 언어 토글(`#langToggle`)을 같은 영역에 배치하면 UX 일관성 향상.
