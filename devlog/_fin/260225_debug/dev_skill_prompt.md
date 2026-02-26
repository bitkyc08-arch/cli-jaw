# A1_CONTENT에 Dev Skill 의무 사용 규칙 추가

> Date: 2026-02-25
> Commit: `2a8dc9b`

## 배경
에이전트가 코드 작성 시 `dev`, `dev-frontend` 등 스킬 가이드를 읽지 않고 작업하는 경우 발생.
기존에는 Skills 동적 주입부(L367–368)에만 언급되어 있었으나, A1_CONTENT 기본값 자체에도 넣어야
파일 우선 모드(A-1.md 편집 시)에서도 보장됨.

## 변경

### `src/prompt/builder.ts` — `A1_CONTENT` Development Rules 섹션

추가된 서브섹션:
```markdown
### Dev Skills (MANDATORY for Development Tasks)
Before writing ANY code, you MUST read the relevant dev skill guides:
1. Always read first: ~/.cli-claw/skills/dev/SKILL.md
2. Role-specific: dev-frontend, dev-backend, dev-data, dev-testing
3. How to read: cat ~/.cli-claw/skills/dev/SKILL.md
4. Follow ALL guidelines from the skill
5. If a skill contradicts these rules, the skill takes priority
```

## 기존 주입 로직과의 관계

| 위치 | 역할 | 동작 |
|------|------|------|
| `A1_CONTENT` L181–191 (신규) | 기본 프롬프트에 자연스럽게 포함 | A-1.md 파일이든 하드코딩이든 항상 |
| Skills 동적 주입 L367–368 (기존) | Active Skills 목록 앞에 dev 스킬 읽기 안내 | 스킬이 1개 이상일 때만 |
| `getEmployeePromptV2()` L473–499 (기존) | 서브에이전트에게 역할별 dev 스킬 전문 주입 | 오케스트레이션 시 |

→ 3중 보장: 메인 에이전트 기본값 + 스킬 동적 주입 + 서브에이전트 역할별 주입
