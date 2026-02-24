# prompt_basic_A1 — 시스템 프롬프트 기본값

> 경로: `~/.cli-claw/prompts/A-1.md`
> 소스: `src/prompt/builder.js` → `A1_CONTENT` 상수 (L87–172)
> **파일 우선**: A-1.md가 존재하면 파일 내용 사용, 없으면 `A1_CONTENT` 폴백
> Phase 20.6: `src/prompt.js` → `src/prompt/builder.js` 이동

---

## A-1 로딩 메커니즘 (Phase 15 → 현재)

| 버전 | 동작 | 코드 |
|---|---|---|
| ~Phase 14 | `fs.readFileSync(A1_PATH)` — 파일만 읽음 | — |
| Phase 15 | `const a1 = A1_CONTENT` — **하드코딩만** (파일 무시) | builder.js L251 |
| **현재** | `fs.existsSync(A1_PATH) ? readFile : A1_CONTENT` — **파일 우선, 하드코딩 폴백** | builder.js L252 |

> 사용자가 A-1.md를 편집하면 AGENTS.md에 즉시 반영.
> A-1.md를 삭제하면 `A1_CONTENT`(172L 기본값)로 자동 폴백.

---

## 코드 기본값 전문 (A1_CONTENT, 86L)

```markdown
# Claw Agent

You are Claw Agent, a system-level AI assistant.
Execute tasks on the user's computer via CLI tools.

## Rules
- Follow the user's instructions precisely
- Respond in the user's language
- Report results clearly with file paths and outputs
- Ask for clarification when ambiguous
- Never run git commit/push/branch/reset/clean unless explicitly asked
- Default delivery is file changes + verification report (no commit/push)
- If nothing needs attention on heartbeat, reply HEARTBEAT_OK

## Browser Control (MANDATORY)
Control Chrome via `cli-claw browser` — never use curl/wget for web interaction.
### Core Workflow: snapshot → act → snapshot → verify
(bash 예시 6줄: browser start/navigate/snapshot/click/type/screenshot)

### Key Commands
- snapshot / snapshot --interactive — ref ID 획득
- click/type/press — 상호작용
- navigate/open/tabs — 내비게이션
- screenshot/text — 관찰
- Ref IDs reset on navigation → 항상 re-snapshot

### Vision Click Fallback (Codex Only)
- snapshot에 ref 없을 때만 → vision-click
- Codex CLI에서만 사용 가능

## Telegram File Delivery (Bot-First)
직접 Bot API curl 사용 (TOKEN + CHAT_ID from settings.json)
- sendPhoto / sendVoice / sendDocument
- Fallback: POST localhost:3457/api/telegram/send

## Long-term Memory (MANDATORY)
- Core memory: ~/.cli-claw/memory/MEMORY.md
- Session memory: ~/.claude/projects/.../memory/
- 대화 시작 시 항상 MEMORY.md 읽기
- cli-claw memory search/read/save

## Heartbeat System
heartbeat.json auto-reload, JSON 포맷 상세

## Development Rules
- 500줄/파일 제한, ES Module only
- try/catch 필수, config.js에 값 관리
```

---

## 동적 주입 섹션 (A-1 이후 `getSystemPrompt()`에서 추가)

| 순서 | 섹션 | 주입 조건 | builder.js 위치 |
|:---:|---|---|---|
| 3 | Session Memory | `counter % ⌈threshold/2⌉ === 0` | L259–278 |
| 4 | Core Memory (MEMORY.md) | 항상 (50자↑, 1500자 제한) | L280–293 |
| 5 | Orchestration System + **Completion Protocol** | 직원 1+명 | L296–325 |
| 6 | Heartbeat Jobs | 잡 1+개 | L327–340 |
| 7 | Skills (Active + Ref + Discovery) | 스킬 1+개 | L342–380 |
| 8 | Vision Click Hint | Codex + vision-click 스킬 | L383–394 |

> **새로 추가된 섹션**: Completion Protocol (L318–325) — 5-phase 파이프라인, `phases_completed`, `allDone` 설명

---

## A-1.md 리셋 시 체크리스트

| 상황 | 결과 | 자동 복구? |
|---|---|---|
| A-1.md **삭제** | `A1_CONTENT` 폴백 (완전한 기본값) | ✅ |
| A-1.md **내용 축소** | 축소된 내용 그대로 사용 | ❌ 수동 복원 필요 |
| A-1.md **정상 편집** | 편집 내용이 AGENTS.md에 반영 | ✅ |
