# (fin) Phase 13 — 기타(Other) 스킬 필터 + Registry 보완

## 개요

Codex 번들 스킬 10개가 `registry.json`에 등록되지 않아 카테고리 필터에서 누락되는 문제 수정.  
추가로 "📂 기타" 필터 버튼으로 미분류 스킬도 조회 가능하게 함.

---

## 1. Registry 보완

#### [MODIFY] `skills_ref/registry.json`

누락된 10개 Codex 폴백 스킬 추가 (총 53 → 63개):

| ID                    | Name                  | Category |
| --------------------- | --------------------- | -------- |
| `doc`                 | Document (docx)       | utility  |
| `gh-address-comments` | GitHub PR 코멘트 처리 | devtools |
| `gh-fix-ci`           | GitHub CI 수정        | devtools |
| `imagegen`            | 이미지 생성 (OpenAI)  | ai-media |
| `openai-docs`         | OpenAI Docs           | devtools |
| `pdf`                 | PDF 읽기/리뷰         | utility  |
| `playwright`          | Playwright 브라우저   | devtools |
| `screenshot`          | Desktop Screenshot    | utility  |
| `spreadsheet`         | Spreadsheet (xlsx)    | utility  |
| `yeet`                | Git Yeet              | devtools |

---

## 2. 기타 필터

#### [MODIFY] `public/index.html`

```html
<button class="skill-filter" data-filter="other">📂 기타</button>
```

#### [MODIFY] `public/js/features/skills.js`

```js
const KNOWN_CATS = ['productivity', 'communication', 'devtools', 'ai-media', 'utility', 'smarthome', 'automation'];

// 'other' 필터: KNOWN_CATS에 속하지 않는 스킬 표시
} else if (state.currentSkillFilter === 'other') {
    filtered = state.allSkills.filter(s => !KNOWN_CATS.includes(s.category));
}
```

---

## 체크리스트

- [x] `skills_ref/registry.json` — 10개 스킬 추가
- [x] `public/index.html` — "📂 기타" 필터 버튼
- [x] `public/js/features/skills.js` — `KNOWN_CATS` + `other` 필터 로직
