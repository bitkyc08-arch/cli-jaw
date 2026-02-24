# Phase 7.1 — Skills Registry & Data i18n

> Phase 7 프론트엔드 i18n 인프라 완성 후, **데이터 레이어** i18n 전환.

## 현황 분석

| 항목 | 수치 |
|------|------|
| 총 스킬 | 107개 |
| 한국어 description | **107/107** (100%) |
| 한국어 name | **19/107** (18%) |
| 카테고리 | 8개 (devtools 51, productivity 14, ai-media 14, utility 12, communication 6, orchestration 5, automation 3, smarthome 2) |

---

## Step 1: `registry.json` 이중 키 변환

### 변환 스크립트 (`scripts/i18n-registry.mjs`)

```js
// 1. 기존 name/description을 name_ko/desc_ko로 복사
// 2. GPT/수동으로 name_en/desc_en 번역 추가
// 3. 기존 name/description 필드는 유지 (하위호환)
```

### 스킬 필드 구조 (After)

```json
{
  "browser": {
    "name": "브라우저 조작",
    "name_ko": "브라우저 조작",
    "name_en": "Browser Control",
    "emoji": "🌐",
    "category": "utility",
    "description": "Chrome 브라우저 조작. ref 스냅샷으로 페이지 요소 식별 → 클릭/입력.",
    "desc_ko": "Chrome 브라우저 조작. ref 스냅샷으로 페이지 요소 식별 → 클릭/입력.",
    "desc_en": "Chrome browser automation. Identify elements via ref snapshots → click/type.",
    "requires": { "bins": ["cli-claw"] },
    "install": null
  }
}
```

### 한국어 name이 있는 19개 스킬 (영어 name 필요)

| id | 현재 name (ko) | name_en |
|----|---------------|---------|
| notion | Notion | Notion |
| obsidian | Obsidian | Obsidian |
| things-mac | Things 3 (macOS) | Things 3 (macOS) |
| himalaya | himalaya | himalaya |
| gog | GOG | GOG |
| xurl | xurl | xurl |
| browser | 브라우저 조작 | Browser Control |
| vision-click | 비전 기반 좌표 클릭 | Vision Click |
| tts | TTS (say) | TTS (say) |
| screen-capture | 스크린샷/녹화 | Screen Capture |
| atlas | Atlas (ChatGPT) | Atlas (ChatGPT) |
| dev | Dev Common | Dev Common |
| dev-frontend | Dev Frontend | Dev Frontend |
| dev-backend | Dev Backend | Dev Backend |
| dev-data | Dev Data | Dev Data |
| dev-testing | Dev Testing | Dev Testing |
| telegram-send | 텔레그램 직접 전송 | Telegram Send |
| openhue | OpenHue | OpenHue |
| nano-banana-pro | 이미지 생성 (Gemini) | Image Gen (Gemini) |

---

## Step 2: 서버 — `/api/skills` locale 지원

### 변경 파일: `server.js`

```diff
-app.get('/api/skills', (_, res) => res.json(getMergedSkills()));
+app.get('/api/skills', (req, res) => {
+    const lang = req.query.locale || 'ko';
+    const suffix = lang === 'ko' ? '_ko' : '_en';
+    const skills = getMergedSkills().map(s => ({
+        ...s,
+        name: s['name' + suffix] || s.name,
+        description: s['desc' + suffix] || s.description,
+    }));
+    res.json(skills);
+});
```

---

## Step 3: 프론트엔드 — `skills.js` fetch 변경

### 변경 파일: `public/js/features/skills.js`

```diff
-const res = await fetch('/api/skills');
+const res = await fetchWithLocale('/api/skills');
```

`fetchWithLocale()`가 `?locale=xx` 자동 추가 → `setLang()` 시 `loadSkills()` 이미 호출됨.

---

## Step 4: 서브에이전트 이름 마이그레이션

### 변경 파일: `src/config.js` → `runMigration()`

```js
const NAME_MAP = {
    '프런트': 'Frontend', '프론트': 'Frontend',
    '백엔드': 'Backend', '데이터': 'Data',
    '문서': 'Docs', '독스': 'Docs',
};
// settings.employees.forEach → NAME_MAP 매칭 시 name 변경
```

기존 사용자의 한국어 이름 → 영어로 1회 마이그레이션.

---

## Step 5: 슬래시 커맨드 확인

Phase 6.9에서 `descKey` + `t()` 이미 적용.
- `slash-commands.js`의 `loadCommands()` → `getPreferredLocale()` 전달
- `setLang()` → `loadCommands()` 리로드 추가 완료 (Phase 7)
- **확인만** — 🌐 토글 시 영어 설명으로 바뀌는지 테스트

---

## 작업 순서 & 예상 시간

| # | 작업 | 파일 | 예상 |
|---|------|------|------|
| 1 | 변환 스크립트 작성 | `scripts/i18n-registry.mjs` | 신규 |
| 2 | registry.json 이중 키 적용 | `skills_ref/registry.json` | 107 스킬 ×2 |
| 3 | `/api/skills` locale 지원 | `server.js` L689 | 1줄→6줄 |
| 4 | `skills.js` fetchWithLocale | `public/js/features/skills.js` | 1줄 변경 |
| 5 | 에이전트 이름 마이그레이션 | `src/config.js` | ~10줄 추가 |
| 6 | 테스트 + 검증 | `npm test` + 브라우저 | — |

## 검증 기준

- [ ] `npm test` 116+ 통과
- [ ] 🌐 ko→en: 스킬 name/description 영어로 표시
- [ ] 🌐 en→ko: 스킬 name/description 한국어로 복원
- [ ] 기존 한국어 에이전트 이름 → 영어로 자동 마이그레이션
- [ ] `/api/skills?locale=en` 응답에 영어 name/desc
