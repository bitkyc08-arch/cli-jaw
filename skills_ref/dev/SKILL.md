---
name: dev
description: "Common development guidelines for all orchestrated sub-agents. Enforces modular development, self-reference patterns, skill discovery, and change logging. Always injected by orchestrator."
---

# Dev — 공통 개발 가이드

모든 sub-agent에게 적용되는 필수 개발 규칙.

## 1. 모듈화 개발 필수

- 단일 파일 **500줄 초과 금지**. 넘으면 분리.
- 함수/클래스 단위로 export. 한 파일에 한 책임.
- ES Module (`import`/`export`) 사용. CommonJS 금지.
- 새 파일 생성 시 기존 파일 구조와 네이밍 패턴을 따를 것.

## 2. Self-Reference 패턴

이 프로젝트(cli-claw) 자체를 참고 패턴으로 사용:

| 패턴                | 참고 파일                                                | 설명                          |
| ------------------- | -------------------------------------------------------- | ----------------------------- |
| **API 스킬**        | `browser/SKILL.md` → `server.js` 엔드포인트 → CLI 명령어 | SKILL → API → CLI 3계층       |
| **프런트엔드 모듈** | `public/js/features/*.js`                                | ES Module 기반 기능 분리      |
| **설정 관리**       | `src/config.js`                                          | 경로, 설정, 감지를 한 파일에  |
| **이벤트 통신**     | `src/bus.js` → WebSocket broadcast                       | 서버 → 클라이언트 실시간 통신 |
| **프롬프트 조립**   | `src/prompt.js`                                          | 시스템 프롬프트 동적 생성     |

코드 작성 전에 해당 패턴의 기존 구현을 먼저 읽으세요.

## 3. 스킬 레퍼런스 탐색

필요한 기술이 이 가이드에 없으면 `~/.cli-claw/skills_ref/`에서 관련 스킬을 탐색:

```
~/.cli-claw/skills_ref/
├── react-best-practices/   ← React 컴포넌트/훅/상태 관리
├── postgres/               ← PostgreSQL 쿼리, 스키마
├── security-best-practices/ ← 보안 검토, 취약점 방지
├── static-analysis/        ← 코드 품질, 린트 규칙
├── debugging-checklist/    ← 디버깅 체계적 접근법
├── tdd/                    ← 테스트 주도 개발
├── web-perf/               ← 웹 성능 최적화
└── ... (전체 목록: ls ~/.cli-claw/skills_ref/)
```

관련 스킬이 있으면 `SKILL.md`를 읽고 지침을 따르세요.

## 4. 변경 로그 기록

worklog 파일이 제공되면 **반드시** 아래 형식으로 기록:

```markdown
### [파일명] — [변경 이유]
- 변경 내용: ...
- 영향 범위: 이 파일을 import하는 모듈 → [목록]
- 테스트: [어떻게 검증했는가]
```

## 5. 안전 규칙

- 기존 `export` 절대 삭제하지 말 것 (다른 모듈이 import 중일 수 있음)
- `import` 추가 시 해당 모듈이 실제로 존재하는지 확인
- 설정값은 하드코딩 금지 → `config.js` 또는 `settings.json` 사용
- 에러 핸들링: `try/catch` 필수, 조용한 실패 금지 (최소 `console.error`)
