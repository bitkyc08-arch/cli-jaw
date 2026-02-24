# Phase 7 (finness): 다국어 지원 (i18n)

> 목표: 한/영 전환 + 확장 가능한 i18n
> 디자인: `skills_ref/dev-frontend` — "Meticulously refined in every detail"

---

## 난이도: ★★★☆☆ (중), ~2-3시간

---

## 설계

1. **외부 라이브러리 없음** — 문자열 100개 미만, 자체 구현
2. **JSON 딕셔너리** — `public/locales/{ko,en}.json`
3. **`data-i18n` 속성** — HTML 정적 텍스트 키 바인딩
4. **`t('key')` 함수** — JS 동적 문자열 치환
5. **`localStorage` 저장** — 언어 선택 유지

---

## 작업

#### [NEW] `public/locales/ko.json` (~80 키)
- 모든 UI 문자열 한국어 딕셔너리

#### [NEW] `public/locales/en.json` (~80 키)
- 동일 키 + 영어 값

#### [NEW] `js/features/i18n.js` (~60L)

| 함수 | 역할 |
|------|------|
| `initI18n()` | localStorage → 없으면 `navigator.language` → `loadLocale()` |
| `loadLocale(lang)` | `fetch('/locales/${lang}.json')` → 캐시 |
| `t(key, params?)` | 딕셔너리 조회 + `{count}` 보간 |
| `applyI18n()` | `[data-i18n]` → textContent, `[data-i18n-placeholder]` → placeholder |
| `setLang(lang)` | 교체 + `applyI18n()` + localStorage |

#### [MODIFY] `index.html`
- 정적 텍스트에 `data-i18n="key"` 속성 추가
- 사이드바 하단에 언어 토글 (🇰🇷↔🇺🇸)

#### [MODIFY] 7개 JS 파일
- `settings.js`, `skills.js`, `chat.js`, `heartbeat.js`, `slash-commands.js`, `ui.js`, `memory.js`
- 하드코딩 한국어/영어 → `t('key')` 호출

#### [MODIFY] `main.js`
- `initI18n()` import + bootstrap 호출

---

## 완료 기준

| 항목 | 조건 |
|------|------|
| 한/영 전환 | 토글 → 전체 UI 즉시 전환 |
| 새로고침 유지 | localStorage 복원 |
| fallback | 키 없으면 키 자체 표시 |
| 확장성 | `ja.json` 등 파일 추가만으로 새 언어 |

---

## Phase 6 → 7 순서

Phase 7의 `data-i18n`은 Phase 6의 사이드바 접기와 동일 HTML 영역 수정.
**Phase 6 완료 후 Phase 7 진행** 권장.
