---
created: 2026-02-24
tags: [vision-click, phase1, codex, 구현계획]
status: planning-v2
---

# Vision Click — Phase 1 구현계획 (v2)

> 리뷰 반영 버전. 상세 구현 계획: [implementation_plan.md]

---

## 설계 결정 요약

| 결정             | 선택                             | 근거                                       |
| ---------------- | -------------------------------- | ------------------------------------------ |
| 스킬 분리        | ✅ 별도 `vision-click` 스킬       | Codex-only 제약 명시, browser는 범용       |
| 활성화 방식      | 수동 (`skill install`)           | 자동 활성화는 Phase 2                      |
| mouse-click 위치 | `/api/browser/act` `kind` 확장   | 기존 `click\|type\|press\|hover` 패턴 유지 |
| 에이전트 인지    | `getSystemPrompt()` 동적 주입    | A1_CONTENT 직접 수정 무효하므로            |
| skill install    | `installFromRef()` fallback 추가 | CLI에 skills_ref 경로 누락이어서           |

## 리뷰 피드백 판정

| #   | 포인트                              | 판정   | 이유                          |
| --- | ----------------------------------- | ------ | ----------------------------- |
| 1   | mouse-click은 `/act`의 kind         | ✅ 수용 | 기존 패턴과 일치              |
| 2   | skill install에 skills_ref fallback | ✅ 수용 | CLI에 경로 누락               |
| 3   | A1 대신 getSystemPrompt() 동적 주입 | ✅ 수용 | initPromptFiles 1회성         |
| 4   | registry.json 기존 반영             | ❌ 기각 | `skill reset` 이미 존재       |
| 5   | 스크린샷 경로/DPR                   | ❌ 기각 | 동적 경로 사용, DPR은 Phase 2 |

## 변경 사항 (9개 파일)

| #   | 파일                               | 액션   | 설명                |
| --- | ---------------------------------- | ------ | ------------------- |
| 1   | `skills_ref/vision-click/SKILL.md` | NEW    | 비전 클릭 스킬      |
| 2   | `skills_ref/registry.json`         | MODIFY | 스킬 등록           |
| 3   | `src/browser/actions.js`           | MODIFY | `mouseClick()` 함수 |
| 4   | `src/browser/index.js`             | MODIFY | export 추가         |
| 5   | `server.js`                        | MODIFY | act kind 추가       |
| 6   | `bin/commands/browser.js`          | MODIFY | CLI 서브커맨드      |
| 7   | `bin/commands/skill.js`            | MODIFY | `installFromRef()`  |
| 8   | `src/prompt.js`                    | MODIFY | 동적 힌트 주입      |
| 9   | `skills_ref/browser/SKILL.md`      | MODIFY | 참조 2줄            |

---

## 변경 기록

- 2026-02-24: v1 초안
- 2026-02-24: v2 코드 리뷰 반영 (5건 중 3건 수용, 2건 기각)
