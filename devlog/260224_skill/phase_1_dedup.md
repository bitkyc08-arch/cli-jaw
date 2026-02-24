# (fin) Phase 1 — 스킬 중복 정리 + GitHub 통합 (완료)

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

## 4. 유사 스킬 유지 결정

### TTS: `tts` + `speech` → 유지 ✅

- `tts`: macOS `say` (로컬, 무료, 오프라인, 39줄)
- `speech`: OpenAI TTS API (클라우드, 유료, 고품질, 180줄+, 배치/톤/감정 제어)
- 용도가 완전히 다름 → **각각 유지**

### 이미지 생성: `imagegen` + `nano-banana-pro` → 유지 ✅

- `imagegen`: OpenAI DALL-E / `nano-banana-pro`: Gemini 3 Pro
- API 키·모델 다름 → **각각 유지**

---

## 체크리스트

- [X] 4쌍 중복 제거 + 장점 흡수
- [X] GitHub 4개 서브스킬 통합
- [X] registry.json 갱신 (62→54)
- [X] TTS/이미지생성 유지 결정
