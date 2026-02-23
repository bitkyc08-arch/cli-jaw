# Phase 6 — 스킬 마켓 + 채널 확장

## 핵심 설계: 2-Tier 스킬 시스템

### 아이디어

스킬을 **2단계로 나눈다**: 레퍼런스(전부 포함) + 활성(실제 사용).

```
~/.cli-claw/
├── skills_ref/              ← 📖 레퍼런스 (npm install 시 전부 포함)
│   ├── registry.json        ←    스킬 메타데이터 인덱스
│   ├── notion/SKILL.md      ←    읽기 전용, 시스템 프롬프트에 직접 주입 안 됨
│   ├── himalaya/SKILL.md
│   ├── github/SKILL.md
│   └── ... (30개+)
│
└── skills/                  ← ⚡ 활성 스킬 (시스템 프롬프트에 주입됨)
    ├── weather/SKILL.md     ←    여기 있는 것만 AI가 항상 기억
    └── notion/SKILL.md      ←    유저가 활성화한 것만
```

### 작동 흐름

```
[자동 모드 — AI가 알아서]

유저: "노션에 회의록 정리해줘"
  ↓
시스템 프롬프트에 이런 문구가 있음:
  "사용 가능한 스킬 레퍼런스가 ~/.cli-claw/skills_ref/ 에 있습니다.
   유저가 특정 도구를 요청하면 해당 SKILL.md를 읽고 지시대로 실행하세요.
   작동 확인 후 유저에게 활성 스킬로 등록할지 물어보세요."
  ↓
AI: skills_ref/notion/SKILL.md 읽음
AI: curl로 Notion API 호출 → 페이지 생성 완료
AI: "Notion 스킬을 활성화할까요? (매번 읽지 않아도 됩니다)"
  ↓
유저: "ㅇㅇ"
AI: skills_ref/notion/SKILL.md → skills/notion/SKILL.md 복사
  ↓
이후부터 Notion 스킬이 시스템 프롬프트에 항상 포함됨
```

```
[수동 모드 — CLI로 직접]

# 스킬 목록 보기 (skills_ref에서)
claw skills list

# 활성화 (skills_ref → skills 복사)
claw skills enable notion weather github

# 비활성화 (skills에서 삭제)
claw skills disable notion

# 전부 활성화
claw skills enable --all
```

### 왜 이 구조가 좋은가

| vs       | 별도 레포 다운로드                           | 2-Tier (이 방식)                          |
| -------- | -------------------------------------------- | ----------------------------------------- |
| 설치     | `claw skills install notion` (네트워크 필요) | 이미 다 있음. `claw skills enable notion` |
| 오프라인 | ❌ 안 됨                                      | ✅ 바로 가능                               |
| AI 자동  | 별도 구현 필요                               | AI가 ref 읽고 바로 사용                   |
| 용량     | 최소 (~스킬 수 × 5KB)                        | ~200KB (전체 ref 포함)                    |
| 업데이트 | `claw skills update`                         | `npm update cli-claw`                     |

### 시스템 프롬프트 주입 코드

```js
// src/prompt.js — getSystemPrompt() 에 추가

// 1. 활성 스킬 (skills/) — 전문 주입
const activeSkills = loadActiveSkills();  // skills/ 안의 SKILL.md 전부 읽기
if (activeSkills.length) {
    prompt += '\n\n---\n## Active Skills\n';
    for (const s of activeSkills) prompt += `\n### ${s.name}\n${s.content}\n`;
}

// 2. 레퍼런스 경로만 알려줌 (skills_ref/) — 내용은 안 넣음
const refSkills = loadSkillRegistry();  // registry.json에서 목록만
if (refSkills.length) {
    prompt += '\n\n---\n## Available Skills (Reference)\n';
    prompt += '아래 스킬을 사용하려면 파일을 읽어보세요:\n';
    for (const s of refSkills) {
        prompt += `- ${s.emoji} **${s.name}**: ${s.description}`;
        prompt += ` → \`~/.cli-claw/skills_ref/${s.id}/SKILL.md\`\n`;
    }
    prompt += '\n사용 후 활성화하려면 skills/ 폴더에 복사하세요.\n';
}
```

---

## 스킬 전체 카탈로그 (Phase 6.1)

### ✅ Codex 기본 스킬 (27개) — 설치 시 자동 활성

`copyDefaultSkills()`가 `~/.codex/skills/` → `~/.cli-claw/skills/`로 복사.
Codex 전용 Python 스크립트 포함이라 ref로 이동 불가.

| 스킬                          | 설명                                  | 카테고리     |
| ----------------------------- | ------------------------------------- | ------------ |
| atlas                         | ChatGPT Atlas 앱 제어 (macOS)         | devtools     |
| cloudflare-deploy             | Cloudflare Workers/Pages 배포         | devtools     |
| develop-web-game              | 웹 게임 개발 + Playwright 테스트 루프 | devtools     |
| doc                           | .docx 읽기/쓰기 + 렌더링              | utility      |
| figma-implement-design        | Figma → 코드 1:1 변환 (MCP)           | devtools     |
| gh-address-comments           | GitHub PR 리뷰 댓글 처리              | devtools     |
| gh-fix-ci                     | GitHub CI 실패 디버깅                 | devtools     |
| imagegen                      | DALL-E 이미지 생성/편집 (Python)      | ai-media     |
| jupyter-notebook              | .ipynb 생성/편집 (Python)             | devtools     |
| linear                        | Linear 이슈/프로젝트 관리             | productivity |
| netlify-deploy                | Netlify 배포                          | devtools     |
| notion-knowledge-capture      | 대화→Notion 위키/FAQ 캡처             | productivity |
| notion-meeting-intelligence   | 회의 자료 준비 (Notion)               | productivity |
| notion-research-documentation | Notion 리서치→보고서 합성             | productivity |
| notion-spec-to-implementation | 스펙→구현계획→Notion 태스크           | productivity |
| openai-docs                   | OpenAI 공식 문서 검색                 | devtools     |
| pdf                           | PDF 읽기/생성 (Python)                | utility      |
| playwright                    | 브라우저 자동화                       | devtools     |
| render-deploy                 | Render 배포 (Blueprint)               | devtools     |
| screenshot                    | 데스크탑 스크린샷 (macOS)             | utility      |
| sentry                        | Sentry 이슈/이벤트 조회               | devtools     |
| sora                          | Sora 비디오 생성/관리 (Python)        | ai-media     |
| speech                        | OpenAI TTS 음성 합성 (Python)         | ai-media     |
| spreadsheet                   | .xlsx/.csv 편집 (Python)              | utility      |
| transcribe                    | 음성→텍스트 변환 + 다화자 분리        | ai-media     |
| vercel-deploy                 | Vercel 배포                           | devtools     |
| yeet                          | git stage→commit→push→PR 원샷         | devtools     |

### 📦 skills_ref (22개) — 레퍼런스, 유저가 enable하면 활성

OpenClaw 스킬에서 Codex와 안 겹치는 것만 선별.

| 스킬            | 설명                        | 카테고리      | Codex 겹침?                                         |
| --------------- | --------------------------- | ------------- | --------------------------------------------------- |
| notion          | Notion API 기본 CRUD (curl) | productivity  | Codex notion-*는 특화 워크플로, 이건 범용 API       |
| trello          | Trello 보드/카드 관리       | productivity  | ❌ 없음                                              |
| obsidian        | Obsidian 볼트 관리          | productivity  | ❌ 없음                                              |
| things-mac      | Things 3 할일 관리 (macOS)  | productivity  | ❌ 없음                                              |
| apple-notes     | Apple Notes 메모 (macOS)    | productivity  | ❌ 없음                                              |
| apple-reminders | Apple 미리알림 (macOS)      | productivity  | ❌ 없음                                              |
| himalaya        | 이메일 CLI (IMAP)           | communication | ❌ 없음                                              |
| gog             | Google Workspace 통합       | communication | ❌ 없음                                              |
| xurl            | X(Twitter) API              | communication | ❌ 없음                                              |
| github          | GitHub gh CLI 범용          | devtools      | Codex gh-*는 특화(CI/댓글), 이건 범용               |
| gh-issues       | 이슈 자동 수정→PR           | devtools      | Codex gh-fix-ci는 CI 전용, 이건 이슈 전용           |
| tmux            | tmux 세션 원격 제어         | devtools      | ❌ 없음                                              |
| skill-creator   | 새 SKILL.md 생성 가이드     | devtools      | ❌ 없음                                              |
| weather         | 날씨 조회 (wttr.in)         | utility       | ❌ 없음                                              |
| video-frames    | ffmpeg 프레임 추출          | utility       | ❌ 없음                                              |
| summarize       | URL/유튜브 요약             | utility       | ❌ 없음                                              |
| goplaces        | Google Places 장소 검색     | utility       | ❌ 없음                                              |
| 1password       | 1Password CLI 조회          | utility       | ❌ 없음                                              |
| nano-pdf        | PDF 편집 (Python)           | utility       | Codex pdf는 reportlab/pdfplumber, 이건 nano-pdf CLI |
| nano-banana-pro | Gemini 이미지 생성          | ai-media      | Codex imagegen은 DALL-E, 이건 Gemini 모델           |
| spotify-player  | Spotify 재생/검색           | smarthome     | ❌ 없음                                              |
| openhue         | Philips Hue 조명            | smarthome     | ❌ 없음                                              |

### ❌ 제거된 중복 (Codex 기본에 동일 기능 있음)

| ref에서 제거           | 이유                                                        |
| ---------------------- | ----------------------------------------------------------- |
| ~~openai-image-gen~~   | Codex `imagegen`이 DALL-E + 마스크/인페인트 지원 (상위호환) |
| ~~openai-whisper-api~~ | Codex `transcribe`가 다화자 분리까지 지원 (상위호환)        |

### 🚫 OpenClaw 전용 (CLI-Claw 불가)

| 스킬                      | 이유                        |
| ------------------------- | --------------------------- |
| discord, slack            | OpenClaw 채널 플러그인 전용 |
| voice-call                | OpenClaw 음성통화 전용      |
| canvas, clawhub           | OpenClaw UI/Hub 전용        |
| blucli, bluebubbles       | BlueBubbles 복잡 설정       |
| camsnap                   | 하드웨어 특정 의존          |
| model-usage               | codexbar 전용 CLI           |
| coding-agent              | OpenClaw 내부 에이전트      |
| blogwatcher, peekaboo     | OpenClaw 전용 모니터링      |
| food-order, ordercli      | 유럽 전용 서비스            |
| oracle                    | Oracle CLI 전용             |
| bear-notes, imsg, wacli   | 범용성 낮거나 복잡          |
| sonoscli, eightctl        | 하드웨어 의존 높음          |
| sag, sherpa-onnx-tts      | 설치 복잡, 범용성 낮음      |
| healthcheck, session-logs | OpenClaw 구조 전용          |

---

## 스킬 배포 구조

### 본체에 포함: `skills_ref/`

npm 패키지 안에 포함. 설치 시 `~/.cli-claw/skills_ref/`로 복사.

```
cli-claw/
└── skills_ref/
    ├── registry.json
    ├── productivity/
    │   ├── notion/SKILL.md
    │   ├── obsidian/SKILL.md
    │   ├── trello/SKILL.md
    │   └── things-mac/SKILL.md
    ├── communication/
    │   ├── himalaya/SKILL.md
    │   ├── gog/SKILL.md
    │   └── xurl/SKILL.md
    ├── devtools/
    │   ├── github/SKILL.md
    │   └── gh-issues/SKILL.md
    ├── ai-media/
    │   ├── openai-image-gen/SKILL.md
    │   └── nano-banana-pro/SKILL.md
    ├── utility/
    │   ├── weather/SKILL.md
    │   └── video-frames/SKILL.md
    ├── smarthome/
    │   └── openhue/SKILL.md
    └── cli-claw/
        ├── claw-heartbeat/SKILL.md
        ├── claw-employees/SKILL.md
        └── skill-creator/SKILL.md
```

### registry.json

```json
{
  "skills": {
    "notion": {
      "name": "Notion",
      "emoji": "📝",
      "category": "productivity",
      "description": "Notion 페이지/DB 생성·읽기·검색. curl로 API 직접 호출.",
      "requires": { "env": ["NOTION_API_KEY"] },
      "install": null
    },
    "himalaya": {
      "name": "이메일 (Himalaya)",
      "emoji": "📧",
      "category": "communication",
      "description": "터미널에서 이메일 읽기·쓰기·답장·검색. Gmail/Outlook 지원.",
      "requires": { "bins": ["himalaya"] },
      "install": "brew install himalaya"
    }
  }
}
```

### CLI 명령어 (수동 모드)

```bash
claw skills list                      # skills_ref 카탈로그 출력
claw skills enable notion weather     # skills_ref → skills 복사 (활성화)
claw skills disable notion            # skills에서 삭제 (비활성화)
claw skills enable --all              # 전부 활성화
```

---

## 채널 계획 (6.2~6.4)

### 6.2 Discord 채널

| 항목       | 내용                                                                |
| ---------- | ------------------------------------------------------------------- |
| 파일       | `src/discord.js` (~200줄)                                           |
| 라이브러리 | discord.js                                                          |
| 기능       | DM/서버채널, slash commands (/ask, /stop), typing 표시, 2000자 분할 |
| 설정       | `DISCORD_TOKEN` + `settings.discord.allowedChannels`                |

### 6.3 WhatsApp — 기여자 모집 후 (Puppeteer 기반, 복잡)

### 6.4 채널 인터페이스 통합 — 3개+ 채널 확보 후 리팩토링

---

## 실행 순서

```
6.1a skills_ref/ 디렉토리 + registry.json 생성
6.1b src/prompt.js에 2-Tier 로드 로직 추가
6.1c claw skills enable/disable/list CLI
6.1d Web UI 스킬 관리
    ↓
6.2 Discord 채널
    ↓
6.3 WhatsApp (기여자)
    ↓
6.4 채널 인터페이스
```

## 체크리스트

- [x] 6.1a: `skills_ref/` 디렉토리 + `registry.json` 생성 (17개 스킬)
- [x] 6.1a: OpenClaw 스킬 복사 + 어댑트 (17개 SKILL.md)
- [ ] 6.1a: CLI-Claw 전용 스킬 작성 (6개)
- [x] 6.1b: `src/prompt.js` — 활성 스킬 주입 + ref 경로 안내
- [x] 6.1b: `src/config.js` — SKILLS_DIR, SKILLS_REF_DIR 상수
- [x] 6.1b: `server.js` — GET/POST /api/skills 라우트 4개
- [ ] 6.1c: `bin/commands/skills.js` — enable/disable/list CLI
- [x] 6.1d: `public/index.html` — 📦 Skills 탭 (카드 UI, 필터, 토글)
- [x] 6.1d: Codex 기본 27개 스킬 자동 표시 (installed 카테고리)
- [ ] 6.2: `src/discord.js` 채널 모듈
- [ ] 6.2: settings/env 연동
- [ ] README: "Add Your Skill" + "Add Your Channel" 가이드
