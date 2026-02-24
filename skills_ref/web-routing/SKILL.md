---
name: web-routing
description: 브라우저 관련 요청을 browser/webapp-testing으로 단순 분기하는 가이드 스킬.
---

# Web Routing

브라우저 계열 요청을 아래 규칙으로 분기합니다.

## Routing Rules

1. 일반 웹 탐색/조작/폼 입력/스크린샷/게시글 작성
- `browser` 사용

2. 로컬 웹앱 E2E/회귀/테스트 자동화
- `webapp-testing` 사용

3. `playwright`라는 이름으로 들어온 요청
- 독립 스킬로 취급하지 않고 `browser`로 매핑
- 단, 테스트 목적이 명확하면 `webapp-testing` 사용

## Fast Decision

- 테스트 관련 키워드(`e2e`, `regression`, `smoke`, `test`)가 있으면: `webapp-testing`
- 없으면: `browser`

