# Phase 12: AGENTS.md 통합 + Ref Skill 경량화

> 작성일: 2026-02-25  
> 상태: `done`  
> 태그: [cli-claw, system-prompt, agents-md]

---

## 배경

5개 CLI별 시스템 프롬프트 주입 경로가 달랐음:

| CLI | 이전 방식 | 문제 |
|-----|----------|------|
| Claude | `--append-system-prompt` stdin | ✅ 작동 |
| Gemini | `GEMINI_SYSTEM_MD` env → tmp 파일 | ✅ 작동 |
| Codex | `{workDir}/.codex/AGENTS.md` 자동 로딩 | ✅ 작동 (but Codex 전용) |
| Copilot | `{workDir}/AGENTS.md` 자동 로딩 | ❌ 파일 없음 → 프롬프트 미적용 |
| OpenCode | `{workDir}/AGENTS.md` 또는 `~/.config/opencode/AGENTS.md` | ❌ 파일 없음 → 프롬프트 미적용 |

**핵심 발견**: Copilot과 OpenCode 둘 다 `.codex/AGENTS.md`는 안 읽고, `{workDir}/AGENTS.md`만 읽음.

---

## 변경 사항

### `src/prompt.js` — `regenerateB()`

```diff
- // Generate CODEX.md in workingDir for compact-protected system prompt
- // Codex reads .codex/AGENTS.md or CODEX.md automatically
+ // Generate {workDir}/AGENTS.md — read by Codex, Copilot, and OpenCode
  try {
      const wd = settings.workingDir || os.homedir();
-     const codexDir = join(wd, '.codex');
-     fs.mkdirSync(codexDir, { recursive: true });
-     fs.writeFileSync(join(codexDir, 'AGENTS.md'), fullPrompt);
+     fs.writeFileSync(join(wd, 'AGENTS.md'), fullPrompt);
  }
```

### 검증 결과 (2026-02-25 02:58)

| CLI | 확인 | 증거 |
|-----|------|------|
| Codex | ✅ | `Agents.md: AGENTS.md` 표시 + `Loaded env: AGENTS.md` |
| Copilot | ✅ | 시스템 프롬프트 적용 확인 |
| OpenCode | ✅ | `Thinking: 시스템 프롬프트에서 브라우저 관련 정보를 찾아봐야` → AGENTS.md 로딩 확인 |
| Claude | ✅ | `--append-system-prompt` 기존 방식 유지 |
| Gemini | ✅ | `GEMINI_SYSTEM_MD` env 기존 방식 유지 |

### `~/.codex/AGENTS.md` 제거

- 삭제 후 Codex가 `~/AGENTS.md`를 정상 로딩 확인
- `.codex/` 경로 불필요

---

## P2: Ref Skill 목록 경량화

### 문제

`Available Skills (90)` 섹션이 AGENTS.md에서 ~6KB 차지.
각 스킬마다 이모지 + 설명 + 전체 경로가 포함되어 있어 토큰 낭비.

### 해법

ref 스킬은 **이름만 나열** (이모지, 설명, 경로 제거):

```
Before: - 📋 Trello: Trello 보드·리스트·카드 관리. curl로 REST API 호출. → `/Users/junny/.cli-claw/skills_ref/trello/SKILL.md`
After:  trello, obsidian, things-mac, apple-notes, ...
```

**변경 파일**: `src/prompt.js` — `getSystemPrompt()` ref 스킬 섹션

---

## 최종 아키텍처

```
regenerateB()
├── ~/.cli-claw/prompts/B.md          ← 백업/감사용
├── {workDir}/AGENTS.md               ← Codex + Copilot + OpenCode (NEW)
│
spawnAgent()
├── Claude  → --append-system-prompt  ← stdin 주입
├── Gemini  → GEMINI_SYSTEM_MD env    ← tmp 파일
├── Codex   → {workDir}/AGENTS.md     ← 자동 로딩 (통합됨)
├── Copilot → {workDir}/AGENTS.md     ← 자동 로딩 (통합됨)
└── OpenCode→ {workDir}/AGENTS.md     ← 자동 로딩 (통합됨)
```
