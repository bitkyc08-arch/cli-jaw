# (fin) Phase 6.1 — 2-Tier 스킬 시스템

> 구현일: 2026-02-23
> 상태: ✅ 완료

## 핵심 아이디어

스킬을 2단계로 분리:
- **Active** (`~/.cli-claw/skills/`) — CLI 도구가 직접 트리거. 시스템 프롬프트에 이름만 주입.
- **Reference** (`~/.cli-claw/skills_ref/`) — AI가 필요할 때 SKILL.md 파일을 읽고 실행.

```
~/.cli-claw/
├── skills/              ← ⚡ 활성 (CLI가 자동 트리거)
│   ├── imagegen/        ←    Codex 기본 27개
│   ├── playwright/
│   └── ...
│
├── skills_ref/          ← 📦 레퍼런스 (AI가 on-demand 읽기)
│   ├── registry.json    ←    메타데이터 인덱스
│   ├── weather/         ←    22개 OpenClaw 스킬
│   ├── browser/         ←    유저 추가 스킬
│   └── ...
```

## 스킬 흐름

```
CLI 도구 (codex/claude):
  .agents/skills/ symlink → ~/.cli-claw/skills/ → 자동 트리거

시스템 프롬프트 주입 (prompt.js):
  1. Active 이름 목록 (동적) — "imagegen, screenshot, ..."
  2. Ref 스킬 목록 (정적) — "📧 himalaya: 이메일 CLI → path"
  3. Skill Discovery — "없으면 검색하거나 만들어라"

Web UI:
  📦 Skills 탭 → 카드 목록 → 토글 ON/OFF
  GET /api/skills → POST /api/skills/enable|disable
```

## 변경 파일

| 파일                       | 변경                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `src/config.js`            | `SKILLS_DIR`, `SKILLS_REF_DIR` 상수, `ensureDirs()`                                    |
| `src/prompt.js`            | `loadActiveSkills()`, `loadSkillRegistry()`, `getMergedSkills()`, 이름만 프롬프트 주입 |
| `server.js`                | `GET /api/skills`, `POST enable/disable`, `GET :id`                                    |
| `public/index.html`        | 📦 Skills 탭 (카드 UI + 카테고리 필터 + 토글)                                           |
| `skills_ref/registry.json` | 22개 스킬 메타데이터                                                                   |
| `skills_ref/*/SKILL.md`    | 22개 OpenClaw 스킬 복사                                                                |

## 스킬 현황

| 티어     | 개수 | 소스                                                     | 프롬프트       |
| -------- | ---- | -------------------------------------------------------- | -------------- |
| ✅ Active | 27   | Codex 기본 (`copyDefaultSkills`)                         | 이름만         |
| 📦 Ref    | 22   | OpenClaw 선별 + 유저 추가                                | 이름+설명+경로 |
| ❌ 제외   | 2    | 중복 (imagegen↔openai-image-gen, transcribe↔whisper-api) | —              |
| 🚫 불가   | ~15  | OpenClaw 전용                                            | —              |

## 확장

- `skills_ref/`에 폴더 + `registry.json` 항목 추가 → GUI 자동 인식
- `skills/`에 폴더 + `SKILL.md` 넣으면 → 활성 스킬로 CLI 자동 트리거
- AI가 Skill Discovery 지시에 따라 새 스킬 생성 가능

## 검증

- ✅ 서버 부팅 OK
- ✅ `GET /api/skills` → 49개 (27 active + 22 ref)
- ✅ Web UI Skills 탭 렌더링 + 토글 ON/OFF
- ✅ 카테고리 필터 (전체/설치됨/생산성/커뮤/개발/AI/유틸/홈)

## 남은 항목

- [ ] `bin/commands/skills.js` — CLI `claw skills enable/disable/list`
- [ ] CLI-Claw 전용 스킬 작성 (claw-heartbeat, claw-employees 등)
- [ ] Codex 스킬 선별 복사 (핵심만 active, 나머지 ref)
