# Phase 7 (finness): 다국어 지원 (i18n)

> 목표: 한/영 전환 + 확장 가능한 i18n  
> **전제: Phase 6.9 완료** (서버 `t()`, 3-인터페이스 locale ctx, 프롬프트 분리, i18n API)  
> 디자인: `skills_ref/dev-frontend` — Meticulously refined

---

## 난이도: ★★☆☆☆ (하-중), ~2-3시간

> Phase 6.9에서 서버 `src/i18n.js`, locale ctx 전파, 프롬프트 분리 완료 전제.  
> Phase 7은 **프런트엔드 i18n 모듈 + locale JSON 값 채우기 + UI 토글**만 수행.

---

## 설계

1. **외부 라이브러리 없음** — ~170 키, 자체 구현
2. **JSON 딕셔너리** — `public/locales/{ko,en}.json` (Phase 6.9에서 스켈레톤 생성)
3. **`data-i18n` 속성** — HTML 정적 텍스트 키 바인딩
4. **`t('key')` 함수** — JS 동적 문자열 치환 (프런트 전용, 서버 `t()`와 별도)
5. **`localStorage` 저장** — 언어 선택 유지
6. **`fetchWithLocale()` 래퍼** — 서버 요청 시 `?locale=xx` 쿼리 자동 주입 (Accept-Language 대신 명시적 파라미터)
7. **`/api/i18n/languages`** — Phase 6.9 API로 사용 가능 언어 자동 감지

---

## 작업

#### [NEW] `js/features/i18n.js` (~70L)

| 함수 | 역할 |
|------|------|
| `initI18n()` | localStorage (try/catch + 메모리 fallback) → 없으면 `navigator.language` 감지 → `normalizeLocale()` → `loadLocale()` |
| `loadLocale(lang)` | `fetch('/api/i18n/${lang}')` → 캐시 |
| `t(key, params?)` | 딕셔너리 조회 + `{count}` 보간 + fallback (키 자체 표시) |
| `applyI18n()` | `[data-i18n]` → textContent, `[data-i18n-placeholder]` → placeholder, `[data-i18n-title]` → title |
| `setLang(lang)` | locale 교체 + `applyI18n()` + localStorage (try/catch) + **WS 재연결** (?lang= 쿼리) |
| `getLangs()` | `/api/i18n/languages` → 사용 가능 언어 목록 |
| `fetchWithLocale(url, init?)` | `fetch()` 래퍼 — URL에 `?locale=xx` 쿼리 자동 추가 |

#### [MODIFY] `public/locales/ko.json` (~170 키 값 채우기)
- Phase 6.9에서 생성된 스켈레톤에 한국어 값 작성
- 섹션: `cmd.*`, `skill.*`, `emp.*`, `chat.*`, `hb.*`, `mem.*`, `phase.*`, `ws.*`, `btn.*`, `status.*`

#### [MODIFY] `public/locales/en.json` (~170 키)
- 동일 키 + 영어 값

#### [MODIFY] `index.html`
- 정적 텍스트 30+개에 `data-i18n`, `data-i18n-placeholder`, `data-i18n-title` 속성 추가
- 사이드바 하단에 언어 토글 (🇰🇷↔🇺🇸)

#### [MODIFY] 9개 JS 파일에서 `t('key')` 치환
- `skills.js`, `chat.js`, `heartbeat.js`, `slash-commands.js`
- `employees.js`, `memory.js`, `ui.js`, `ws.js`
- `settings.js` (있는 경우)

#### [MODIFY] `main.js`
- `import { initI18n } from './features/i18n.js'`
- `await initI18n()` bootstrap

#### [MODIFY] `public/js/ws.js`
- WS 연결 시 `?lang=xx` 쿼리 추가: `new WebSocket(\`ws://${location.host}?lang=${currentLocale}\`)`
- `setLang()` 호출 시 WS 재연결

---

## 완료 기준

| 항목 | 조건 |
|------|------|
| 한/영 전환 | 토글 → 전체 UI 즉시 전환 (정적 + 동적 문자열 모두) |
| 서버 응답 | 커맨드 응답·에러 메시지가 클라이언트 locale에 맞춰 표시 |
| 새로고침 유지 | localStorage 복원 (try/catch + 메모리 fallback) |
| fallback | 키 없으면 키 자체 표시 |
| 확장성 | `ja.json` 파일 추가만으로 새 언어 |
| Backend API | `/api/i18n/languages` → 자동 감지 |
| WS locale | `setLang()` 시 WS 재연결으로 locale 전파 |
| 프롬프트 독립 | UI 영어 전환해도 Agent 프롬프트는 A-2 Language 설정 유지 |
| 기존 기능 | 한국어 기본 설정에서 모든 기존 기능 정상 |
| 스킬 표시 | locale에 따라 skill name/description 전환 |

---

## Phase 순서 의존성

```
Phase 6 (사이드바 접기/테마) ← 완료
    ↓
Phase 6.9 (i18n 인프라) ← src/i18n.js (t, normalizeLocale, getPromptLocale),
    │                      3-인터페이스 locale ctx, Vary/Content-Language 헤더,
    │                      telegram setMyCommands language_code,
    │                      /api/i18n/* 엔드포인트, LEGACY_MAP 확장
    ↓
Phase 7 (본 문서) ← 프런트엔드 i18n.js, locale JSON 값 작성,
                     data-i18n 바인딩, 언어 토글 UI,
                     WS ?lang= 쿼리, localStorage try/catch
```
