# Skill Router 통합 계획 (기준점 고정)

작성일: 2026-02-24  
상태: Draft → 실행 대기

## Implementation Status (Phase 1)

- `skills_ref/playwright` 제거 완료 (standalone 폐기).
- `skills_ref/registry.json`에서 `playwright` 항목 제거 완료.
- `browser` 메타 확장 완료:
  - `canonical_id: browser`
  - `aliases: [playwright]`
  - `workflow: interactive`
  - `provider: n/a`
  - `status: active`
- `webapp-testing` 메타 확장 완료:
  - `canonical_id: webapp-testing`
  - `aliases: []`
  - `workflow: e2e_test`
  - `provider: n/a`
  - `status: active`
- 코드 라우터(`src/skill-router.js`)는 제거하고, 단순 운영 모델로 전환:
  - `skills_ref/web-routing/SKILL.md`에서 분기 규칙만 선언
  - `playwright` 명칭은 `browser` alias로만 처리

## 1) 목표

- 중복 스킬을 정리하되, **프로바이더/워크플로우가 본질적으로 다르면 강제 통합하지 않는다**.
- 스킬 선택 기준을 "이름"이 아니라 **의도(Intent) + 실행 방식(Workflow)** 으로 통일한다.
- 사용자 요청 시 어떤 스킬이 선택되는지 예측 가능하도록 **Router 규칙**을 명시한다.

## 2) 기준점 (Canonical Baseline)

- 웹 자동화 기준점은 `browser`로 고정한다.
- `playwright`는 `browser`와 사용 목적이 중복되므로 **deprecated 후 제거**한다.
- `webapp-testing`은 로컬 앱 E2E/회귀 검증용 워크플로우가 명확히 달라서 **분리 유지**한다.

결론:
- `browser`: 유지 (웹 탐색/조작 표준)
- `playwright`: 제거 대상
- `webapp-testing`: 유지 (테스트 전용)

## 3) 통합 원칙

원칙 A:
- 같은 워크플로우 + 이름만 다르면 통합.

원칙 B:
- 워크플로우가 다르면 분리 유지.

원칙 C:
- 프로바이더만 다른 경우, 기능/입출력이 같으면 "메타 스킬 + provider 라우팅" 허용.

원칙 D:
- 레지스트리는 "하나의 canonical id + alias" 구조로 관리.

## 4) 도메인별 결정

### 4.1 Browser Domain

- Canonical: `browser`
- Deprecate/Remove: `playwright`
- Separate: `webapp-testing`

라우팅 규칙:
- 일반 웹 탐색/폼 입력/게시글 작성/스크린샷: `browser`
- 로컬 앱 테스트, E2E, 회귀 검증, 서버 띄우고 시나리오 실행: `webapp-testing`

### 4.2 문서/표

- `doc` + `docx` → canonical `docx`, `doc`는 alias
- `spreadsheet` + `xlsx` → canonical `xlsx`, `spreadsheet`는 alias
- `pdf` + `nano-pdf` → canonical `pdf`, `nano-pdf`는 advanced profile(alias)

### 4.3 캡처

- `screenshot` + `screen-capture` → canonical `screenshot`, `screen-capture` alias

### 4.4 미디어 (프로바이더 다름)

- `imagegen` + `nano-banana-pro`:
  - 통합 방식: `image` 메타 라우팅(Provider: `openai` | `gemini`)
  - 즉시 물리 병합은 보류, 라우팅만 우선 도입

- `tts` + `speech`:
  - 통합 방식: `tts` 메타 라우팅(Mode: `local` | `openai`)
  - 즉시 물리 병합은 보류

## 5) Router 설계

## 5.1 registry 확장 필드

각 스킬에 아래 필드를 추가:

- `canonical_id`: 대표 스킬 id
- `aliases`: 동의어/구 id 목록
- `workflow`: `interactive`, `e2e_test`, `batch_transform`, `provider_variant` 등
- `provider`: `openai`, `gemini`, `local`, `n/a`
- `status`: `active`, `alias`, `deprecated`
- `deprecates_to`: deprecated일 때 이동 대상

## 5.2 라우팅 방식(코드 없음)

파일: `skills_ref/web-routing/SKILL.md` (신규)

역할:
- 의도별 분기 규칙을 스킬 문서에 고정한다.
- 브라우저 조작은 `browser`, 테스트 의도는 `webapp-testing`으로 안내한다.
- `playwright` 명칭은 alias로만 취급한다.

## 5.3 UI/API 반영

- Skills 탭에서 deprecated 스킬은 "권장 대체" 배지 표시
- `/api/skills` 응답에 `status`, `canonical_id`, `deprecates_to` 포함

## 6) 실행 단계

Phase 1 (즉시):
- `playwright` 디렉터리/registry 항목 제거
- `browser` aliases에 `playwright` 반영
- `web-routing` 스킬 추가 (문서 기반 분기)
- `webapp-testing`는 별도 유지 + "테스트 전용" 태그 추가

Phase 2:
- `doc/docx`, `spreadsheet/xlsx`, `screenshot/screen-capture` alias 정리
- 프롬프트 주입 시 canonical 이름 중심으로 노출

Phase 3:
- provider variant(`image`, `tts`) 메타 라우팅 도입
- 기존 스킬은 alias/profile로 단계적 정리

## 7) 삭제/보존 정책

- 즉시 삭제:
  - `skills_ref/playwright` (Phase 1 완료 후)

- 보존:
  - `skills_ref/webapp-testing` (분리 유지)
  - provider variant 스킬(`imagegen`, `nano-banana-pro`, `speech`, `tts`)은 라우팅 안정화 전까지 유지

## 8) 수용 기준 (Acceptance)

- 유저가 "브라우저 자동화" 요청 시 항상 `browser` 선택
- 유저가 "로컬 웹앱 테스트" 요청 시 `webapp-testing` 선택
- `playwright` 직접 호출 경로 제거 또는 자동 리디렉션
- registry와 디렉터리 정합성(누락/고아 0) 유지

## 9) 리스크

- `playwright` 제거 시 기존 사용자 습관/문서 참조 깨짐
  - 대응: 1회성 deprecation 기간 + 명시적 안내

- provider variant 통합 시 사용자가 결과 품질 차이를 체감할 수 있음
  - 대응: provider 명시 옵션 유지 (`openai`/`gemini`/`local`)

## 10) 다음 작업 제안

1. Phase 1 반영 검증 (`playwright` 제거 + `web-routing` 분기 문서 + registry 메타)
2. UI에 deprecated 배지/대체 스킬 노출
3. 안정화 후 `playwright` 폴더 실제 제거
