# Phase 1 — 스킬 중복 정리 + GitHub 통합

## 개요

`skills_ref/` 내 중복·유사 스킬 정리. 보존 대상에 삭제 대상의 장점을 흡수 후 삭제.

---

## 1. 중복 제거 (4쌍 → 4개 삭제)

| 삭제          | 보존             | 흡수한 내용                                          |
| ------------- | ---------------- | ---------------------------------------------------- |
| `spreadsheet` | `xlsx`           | pandas 데이터 분석 워크플로우, csv/tsv 트리거        |
| `doc`         | `docx`           | 시각 검증 (soffice→PDF→PNG), python-docx 텍스트 추출 |
| `screenshot`  | `screen-capture` | 도구 우선순위 가이드, 권한 프리플라이트              |
| `nano-pdf`    | `pdf`            | nano-pdf 자연어 편집, DOCX→PDF 변환                  |

## 2. GitHub 통합 (4개 → github에 병합)

| 삭제                  | 흡수된 워크플로우                    |
| --------------------- | ------------------------------------ |
| `gh-issues`           | 이슈 자동수정 + PR 오픈 멀티에이전트 |
| `gh-address-comments` | PR 리뷰 코멘트 처리                  |
| `gh-fix-ci`           | 실패 CI 디버깅 → fix plan → 구현     |
| `yeet`                | Stage→Commit→Push→PR 원샷 플로우     |

## 3. Registry 업데이트

- 8개 스킬 삭제 (62 → 54개)
- 보존 스킬 5개 description 갱신 (`xlsx`, `docx`, `screen-capture`, `pdf`, `github`)

---

## 향후 고려 (미구현)

### TTS 통합 (`tts` + `speech`)
- `tts`: macOS `say` 명령 (로컬, 무료, 오프라인)
- `speech`: OpenAI TTS API (클라우드, 유료, 고품질)
- **구상**: `tts` 하나로 통합, provider 선택 (`--provider local|openai`) 또는 description에 둘 다 명시

### 이미지 생성 통합 (`imagegen` + `nano-banana-pro`)
- `imagegen`: OpenAI Images API (DALL-E)
- `nano-banana-pro`: Gemini 3 Pro 이미지 생성
- **구상**: `imagegen` 하나로 통합, provider 선택 (`--provider openai|gemini`) 또는 각각 유지 (API 키 분리)

---

## 체크리스트

- [x] `xlsx/SKILL.md` — pandas, csv/tsv 트리거 흡수
- [x] `docx/SKILL.md` — 시각 검증, python-docx 흡수
- [x] `screen-capture/SKILL.md` — 도구 우선순위 흡수
- [x] `pdf/SKILL.md` — nano-pdf, DOCX→PDF 변환 흡수
- [x] `github/SKILL.md` — 4개 서브스킬 워크플로우 통합
- [x] `registry.json` — 8개 삭제, 5개 description 갱신
- [x] 8개 중복 폴더 삭제
- [ ] TTS 통합 (향후)
- [ ] 이미지 생성 통합 (향후)
