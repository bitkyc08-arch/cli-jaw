# i18n 탭 전환 버그 & 하드코딩 문자열 수정

> Date: 2026-02-25

## 버그: 우측 사이드바 탭 전환 먹통

### 증상
채팅 시작 후 우측 사이드바의 에이전트/스킬/설정 탭 전환 버튼이 동작하지 않음.

### 원인
`main.js`의 탭 전환 코드가 `textContent`를 **영어 하드코딩**으로 비교:
```js
// ❌ i18n 적용 후 한국어라서 매칭 안 됨
const text = btn.textContent.trim();
if (text.includes('Agents')) switchTab('agents', btn);
```

### 수정
인덱스 기반 매칭으로 변경 — 언어 무관:
```js
// ✅ 위치(인덱스)로 판별
const tabs = [...btn.parentElement.children].filter(c => c.classList.contains('tab-btn'));
const idx = tabs.indexOf(btn);
const names = ['agents', 'skills', 'settings'];
if (names[idx]) switchTab(names[idx], btn);
```

### 커밋
`e4434fb` — `fix(ui): tab switching broken when i18n active`

---

## 하드코딩 한국어 문자열 → i18n 키 변환

### 수정 대상 4건

| 파일 | 기존 | i18n 키 |
|------|------|---------|
| `render.js:103` | `'복사'` | `code.copy` |
| `render.js:178` | `'복사됨 ✓'` | `code.copied` |
| `render.js:191` | `'🎯 작업 분배 중...'` | `orchestrator.dispatching` |
| `settings.js:168` | `'(no servers configured)'` | `mcp.noServers` |

### 추가 수정
`render.js`에 `import { t } from './features/i18n.js'` 추가 시,
기존 `escapeHtml(t)` 함수의 파라미터 `t`가 import와 이름 충돌.
→ 파라미터명 `t` → `str`로 변경.

### 영향
기능 버그는 아니었으나 (UI 표시 전용), 다국어 지원 시 영어 환경에서 한국어가 표시됨.

### 커밋
후속 커밋 — `fix(i18n): replace hardcoded Korean strings with t() calls`
