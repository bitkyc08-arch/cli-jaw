# (fin) Phase 0 — 스킬 전수 GO/NO 판정 (2026-02-24, 최종)

> **11 active + 56 ref** (Phase 1 dedup 반영, 좀비 0)
> 보류 없음. 모든 스킬 **✅ GO** 또는 **❌ NO** 확정.
> 원칙: 기존에 없는 기능 → GO / EXIST와 중복 → NO (통합 대상 명시)

---

## 📦 EXIST 요약 (67개)

**Active 11**: `browser`, `docx`, `frontend-design`, `github`, `imagegen`, `memory`, `notion`, `openai-docs`, `pdf`, `screen-capture`, `xlsx`

**Ref 56**: `1password`, `apple-notes`, `apple-reminders`, `atlas`, `cloudflare-deploy`, `develop-web-game`, `doc-coauthoring`, `docx`, `figma-implement-design`, `frontend-design`, `github`, `gog`, `goplaces`, `himalaya`, `imagegen`, `jupyter-notebook`, `linear`, `mcp-builder`, `memory`, `nano-banana-pro`, `netlify-deploy`, `notion`, `notion-*`×4, `obsidian`, `openai-docs`, `openhue`, `pdf`, `playwright`, `pptx`, `render-deploy`, `screen-capture`, `sentry`, `skill-creator`, `sora`, `speech`, `spotify-player`, `summarize`, `theme-factory`, `things-mac`, `tmux`, `transcribe`, `trello`, `tts`, `vercel-deploy`, `video-frames`, `vision-click`, `weather`, `web-artifacts-builder`, `web-routing`, `webapp-testing`, `xlsx`, `xurl`

---

## 🌐 외부 스킬 — 최종 GO/NO (보류 없음)

### Anthropic

| 스킬                | 판정 | 사유                            |
| ------------------- | ---- | ------------------------------- |
| `algorithmic-art`   | ✅ GO | 새 기능 (p5.js 제너러티브 아트) |
| `canvas-design`     | ✅ GO | 새 기능 (PNG/PDF 시각 디자인)   |
| `brand-guidelines`  | ❌ NO | `theme-factory` EXIST에 통합    |
| `slack-gif-creator` | ❌ NO | Slack 전용                      |
| `internal-comms`    | ❌ NO | 기업 내부용                     |

### Vercel Engineering

| 스킬                    | 판정 | 사유                                |
| ----------------------- | ---- | ----------------------------------- |
| `react-best-practices`  | ✅ GO | 새 기능 (React 코드 패턴)           |
| `next-best-practices`   | ✅ GO | 새 기능 (Next.js 패턴)              |
| `next-upgrade`          | ✅ GO | 새 기능 (Next.js 버전 마이그레이션) |
| `web-design-guidelines` | ❌ NO | `frontend-design` EXIST가 커버      |
| `composition-patterns`  | ❌ NO | `react-best-practices` GO에 포함    |
| `next-cache-components` | ❌ NO | `next-best-practices` GO에 통합     |
| `react-native-skills`   | ❌ NO | RN 미사용                           |

### Cloudflare

| 스킬                                | 판정 | 사유                                             |
| ----------------------------------- | ---- | ------------------------------------------------ |
| `web-perf`                          | ✅ GO | 새 기능 (Core Web Vitals 감사)                   |
| `agents-sdk`                        | ✅ GO | 새 기능 (CF Workers AI 에이전트)                 |
| `durable-objects`                   | ✅ GO | 새 기능 (RPC+SQLite+WebSocket 스테이트풀)        |
| `building-mcp-server-on-cloudflare` | ❌ NO | `mcp-builder` + `cloudflare-deploy` EXIST에 통합 |
| `wrangler`                          | ❌ NO | `cloudflare-deploy` EXIST                        |

### Trail of Bits

| 스킬                     | 판정 | 사유                              |
| ------------------------ | ---- | --------------------------------- |
| `static-analysis`        | ✅ GO | 새 기능 (CodeQL+Semgrep)          |
| `insecure-defaults`      | ✅ GO | 새 기능 (시크릿 탐지)             |
| `modern-python`          | ✅ GO | 새 기능 (uv+ruff+pytest)          |
| `differential-review`    | ✅ GO | 새 기능 (보안 관점 diff 리뷰)     |
| `property-based-testing` | ✅ GO | 새 기능 (다언어 속성 기반 테스트) |
| `semgrep-rule-creator`   | ❌ NO | `static-analysis` GO에 통합       |

### OpenAI 공식

| 스킬                      | 판정 | 사유                                      |
| ------------------------- | ---- | ----------------------------------------- |
| `security-best-practices` | ✅ GO | 새 기능 (언어별 보안 리뷰 패턴)           |
| `security-ownership-map`  | ✅ GO | 새 기능 (코드베이스 소유자/버스팩터 매핑) |
| `security-threat-model`   | ✅ GO | 새 기능 (리포별 위협 모델 생성)           |
| `figma` (fetch-only)      | ❌ NO | `figma-implement-design` EXIST            |

### HuggingFace

| 스킬                         | 판정 | 사유                                |
| ---------------------------- | ---- | ----------------------------------- |
| `hugging-face-cli`           | ✅ GO | 새 기능 (HF Hub 모델/데이터셋 관리) |
| `hugging-face-model-trainer` | ✅ GO | 새 기능 (SFT/DPO/GRPO 학습)         |
| `hugging-face-evaluation`    | ✅ GO | 새 기능 (vLLM/lighteval 모델 평가)  |
| `hugging-face-datasets`      | ❌ NO | `hugging-face-cli` GO에 통합        |
| `hugging-face-trackio`       | ❌ NO | 대규모 ML 전용                      |

### fal.ai

| 스킬             | 판정 | 사유                                    |
| ---------------- | ---- | --------------------------------------- |
| `fal-image-edit` | ✅ GO | 새 기능 (AI 스타일 전환, 오브젝트 제거) |
| `fal-generate`   | ❌ NO | `imagegen` + `nano-banana-pro` EXIST    |
| `fal-audio`      | ❌ NO | `speech` + `transcribe` EXIST           |
| `fal-upscale`    | ❌ NO | 니치 기능                               |

### obra/superpowers ⭐⭐⭐

| 스킬                          | 판정 | 사유                                       |
| ----------------------------- | ---- | ------------------------------------------ |
| `brainstorming`               | ✅ GO | 새 기능 (구조화된 아이디어→디자인 문서)    |
| `writing-plans`               | ✅ GO | 새 기능 (2-5분 단위 태스크 분해)           |
| `tdd`                         | ✅ GO | 새 기능 (RED-GREEN-REFACTOR 유닛 테스트)   |
| `requesting-code-review`      | ✅ GO | 새 기능 (에이전트 내부 severity 리뷰)      |
| `dispatching-parallel-agents` | ✅ GO | 새 기능 (병렬 서브에이전트)                |
| `debugging-helpers`           | ✅ GO | 새 기능 (디버깅 보조)                      |
| `receiving-code-review`       | ✅ GO | 새 기능 (`requesting-code-review`와 세트)  |
| `git-worktrees`               | ✅ GO | 새 기능 (worktree 격리 브랜치)             |
| `finishing-dev-branch`        | ❌ NO | `github` EXIST + `git-worktrees` GO에 통합 |
| `collaboration-patterns`      | ❌ NO | `dispatching-parallel-agents` GO에 통합    |

### proflead/codex-skills-library ⭐⭐

| 스킬                        | 판정 | 사유                                  |
| --------------------------- | ---- | ------------------------------------- |
| `codebase-orientation`      | ✅ GO | 새 기능 (프로젝트 온보딩 매핑)        |
| `debugging-checklist`       | ✅ GO | 새 기능 (재현→격리→로깅→가설검증)     |
| `error-message-explainer`   | ✅ GO | 새 기능 (컴파일러/런타임 에러 해석)   |
| `config-file-explainer`     | ✅ GO | 새 기능 (설정 파일 구조 설명)         |
| `data-structure-chooser`    | ✅ GO | 새 기능 (자료구조 트레이드오프 추천)  |
| `log-summarizer`            | ✅ GO | 새 기능 (로그 그룹핑+첫 실패 식별)    |
| `linter-fix-guide`          | ✅ GO | 새 기능 (린트 룰 설명+수정 제안)      |
| `dependency-install-helper` | ✅ GO | 새 기능 (플랫폼별 의존성 설치 가이드) |
| `ticket-breakdown`          | ❌ NO | `writing-plans` GO와 중복             |
| `small-script-generator`    | ❌ NO | 에이전트 기본 능력                    |
| `readme-polish`             | ❌ NO | documentation 자체 스킬               |
| `function-docstrings`       | ❌ NO | 에이전트 기본 능력                    |
| `git-basic-helper`          | ❌ NO | `github` EXIST                        |

### ComposioHQ

| 스킬                    | 판정 | 사유                                        |
| ----------------------- | ---- | ------------------------------------------- |
| `changelog-generator`   | ✅ GO | 새 기능 (git→체인지로그)                    |
| `video-downloader`      | ✅ GO | 새 기능 (yt-dlp 래퍼)                       |
| `email-draft-polish`    | ✅ GO | 새 기능 (이메일 톤 조절, himalaya는 전송만) |
| `file-organizer`        | ❌ NO | `doc-sort` 자체 스킬 있음                   |
| `invoice-organizer`     | ❌ NO | 인보이스 전용                               |
| `support-ticket-triage` | ❌ NO | 티켓 전용                                   |

### 기타 커뮤니티

| 스킬                      | 레포            | 판정 | 사유                                              |
| ------------------------- | --------------- | ---- | ------------------------------------------------- |
| `postgres`                | sanjay3290      | ✅ GO | 새 기능 (DB 쿼리)                                 |
| `deep-research`           | sanjay3290      | ✅ GO | 새 기능 (멀티스텝 리서치)                         |
| `context-compression`     | muratcankoylan  | ✅ GO | 새 기능 (컨텍스트 압축)                           |
| `ios-simulator`           | conorluddy      | ✅ GO | 새 기능 (iOS 시뮬레이터 제어)                     |
| `kreuzberg`               | kreuzberg-dev   | ✅ GO | 새 기능 (62+ 포맷 추출, pdf는 PDF만)              |
| `apple-hig-skills`        | raintree-tech   | ✅ GO | 새 기능 (Apple HIG 14개 가이드)                   |
| `aws-skills`              | zxkane          | ✅ GO | 새 기능 (AWS 인프라 자동화)                       |
| `terraform`               | hashicorp       | ✅ GO | 새 기능 (HCL/모듈/프로바이더 IaC)                 |
| `whatsapp`                | gokapso         | ✅ GO | 새 기능 (WhatsApp 메시지/자동화)                  |
| `Dimillian/Skills`        | Dimillian       | ❌ NO | `ios-simulator` GO + `apple-hig-skills` GO에 통합 |
| `multi-agent-patterns`    | muratcankoylan  | ❌ NO | `dispatching-parallel-agents` GO에 통합           |
| `memory-systems`          | muratcankoylan  | ❌ NO | `memory` EXIST + 벡터 메모리 계획 중              |
| `clawsec`                 | prompt-security | ❌ NO | `static-analysis` + `insecure-defaults` GO에 통합 |
| `data-structure-protocol` | k-kolomeitsev   | ❌ NO | 실험적                                            |
| `home-assistant`          | komal-SkyNET    | ❌ NO | `openhue` EXIST                                   |

---

## 📊 최종 집계

| 판정     | 수량    |
| -------- | ------- |
| 📦 EXIST  | 67      |
| ✅ GO     | **51**  |
| ❌ NO     | **28**  |
| **합계** | **146** |

### NO 통합 매핑

| NO 스킬                     | 통합 대상                                    |
| --------------------------- | -------------------------------------------- |
| `brand-guidelines`          | → `theme-factory` EXIST                      |
| `web-design-guidelines`     | → `frontend-design` EXIST                    |
| `composition-patterns`      | → `react-best-practices` GO                  |
| `next-cache-components`     | → `next-best-practices` GO                   |
| `building-mcp-server-on-cf` | → `mcp-builder` EXIST                        |
| `wrangler`                  | → `cloudflare-deploy` EXIST                  |
| `semgrep-rule-creator`      | → `static-analysis` GO                       |
| `figma` (fetch-only)        | → `figma-implement-design` EXIST             |
| `hugging-face-datasets`     | → `hugging-face-cli` GO                      |
| `fal-generate`              | → `imagegen`+`nano-banana-pro` EXIST         |
| `fal-audio`                 | → `speech`+`transcribe` EXIST                |
| `finishing-dev-branch`      | → `github` EXIST                             |
| `collaboration-patterns`    | → `dispatching-parallel-agents` GO           |
| `ticket-breakdown`          | → `writing-plans` GO                         |
| `file-organizer`            | → `doc-sort` 자체 스킬                       |
| `Dimillian/Skills`          | → `ios-simulator` + `apple-hig-skills` GO    |
| `multi-agent-patterns`      | → `dispatching-parallel-agents` GO           |
| `memory-systems`            | → `memory` EXIST                             |
| `clawsec`                   | → `static-analysis` + `insecure-defaults` GO |
| `home-assistant`            | → `openhue` EXIST                            |

---

## 🏆 GO 51개 — 다운로드 목록

### 1. 창작/디자인 (2)
| 스킬              | 레포       |
| ----------------- | ---------- |
| `algorithmic-art` | anthropics |
| `canvas-design`   | anthropics |

### 2. 프런트엔드 (3)
| 스킬                   | 레포        |
| ---------------------- | ----------- |
| `react-best-practices` | vercel-labs |
| `next-best-practices`  | vercel-labs |
| `next-upgrade`         | vercel-labs |

### 3. 성능/인프라 (5)
| 스킬              | 레포       |
| ----------------- | ---------- |
| `web-perf`        | cloudflare |
| `agents-sdk`      | cloudflare |
| `durable-objects` | cloudflare |
| `aws-skills`      | zxkane     |
| `terraform`       | hashicorp  |

### 4. 보안 (5)
| 스킬                     | 레포        |
| ------------------------ | ----------- |
| `static-analysis`        | trailofbits |
| `insecure-defaults`      | trailofbits |
| `differential-review`    | trailofbits |
| `property-based-testing` | trailofbits |
| `modern-python`          | trailofbits |

### 5. 보안 (OpenAI) (3)
| 스킬                      | 레포   |
| ------------------------- | ------ |
| `security-best-practices` | openai |
| `security-ownership-map`  | openai |
| `security-threat-model`   | openai |

### 6. ML (3)
| 스킬                         | 레포        |
| ---------------------------- | ----------- |
| `hugging-face-cli`           | huggingface |
| `hugging-face-model-trainer` | huggingface |
| `hugging-face-evaluation`    | huggingface |

### 7. AI 미디어 (1)
| 스킬             | 레포   |
| ---------------- | ------ |
| `fal-image-edit` | fal-ai |

### 8. 개발 워크플로 (8, obra)
| 스킬                          | 레포 |
| ----------------------------- | ---- |
| `brainstorming`               | obra |
| `writing-plans`               | obra |
| `tdd`                         | obra |
| `requesting-code-review`      | obra |
| `receiving-code-review`       | obra |
| `dispatching-parallel-agents` | obra |
| `debugging-helpers`           | obra |
| `git-worktrees`               | obra |

### 9. DevOps 실용 (8, proflead)
| 스킬                        | 레포     |
| --------------------------- | -------- |
| `codebase-orientation`      | proflead |
| `debugging-checklist`       | proflead |
| `error-message-explainer`   | proflead |
| `config-file-explainer`     | proflead |
| `data-structure-chooser`    | proflead |
| `log-summarizer`            | proflead |
| `linter-fix-guide`          | proflead |
| `dependency-install-helper` | proflead |

### 10. 유틸리티 (6)
| 스킬                  | 레포           |
| --------------------- | -------------- |
| `changelog-generator` | ComposioHQ     |
| `video-downloader`    | ComposioHQ     |
| `email-draft-polish`  | ComposioHQ     |
| `postgres`            | sanjay3290     |
| `deep-research`       | sanjay3290     |
| `context-compression` | muratcankoylan |

### 11. 플랫폼/메시징 (4)
| 스킬               | 레포          |
| ------------------ | ------------- |
| `ios-simulator`    | conorluddy    |
| `apple-hig-skills` | raintree-tech |
| `kreuzberg`        | kreuzberg-dev |
| `whatsapp`         | gokapso       |

---

## 다운로드 명령어

```bash
# 기업 공식
git clone --depth 1 https://github.com/anthropics/skills /tmp/anthropics-skills
git clone --depth 1 https://github.com/vercel-labs/agent-skills /tmp/vercel-skills
git clone --depth 1 https://github.com/cloudflare/skills /tmp/cf-skills
git clone --depth 1 https://github.com/trailofbits/skills /tmp/tob-skills
git clone --depth 1 https://github.com/openai/skills /tmp/openai-skills
git clone --depth 1 https://github.com/huggingface/skills /tmp/hf-skills
git clone --depth 1 https://github.com/fal-ai-community/skills /tmp/fal-skills

# 커뮤니티
git clone --depth 1 https://github.com/obra/superpowers /tmp/superpowers
git clone --depth 1 https://github.com/proflead/codex-skills-library /tmp/proflead-skills
git clone --depth 1 https://github.com/ComposioHQ/awesome-codex-skills /tmp/composio-skills
git clone --depth 1 https://github.com/sanjay3290/ai-skills /tmp/sanjay-skills
git clone --depth 1 https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering /tmp/context-skills
git clone --depth 1 https://github.com/conorluddy/ios-simulator-skill /tmp/ios-sim
git clone --depth 1 https://github.com/raintree-technology/apple-hig-skills /tmp/hig-skills
git clone --depth 1 https://github.com/kreuzberg-dev/kreuzberg /tmp/kreuzberg
git clone --depth 1 https://github.com/gokapso/agent-skills /tmp/gokapso-skills
git clone --depth 1 https://github.com/zxkane/aws-skills /tmp/aws-skills
git clone --depth 1 https://github.com/hashicorp/agent-skills /tmp/terraform-skills
```

## 체크리스트

- [x] Phase 1 dedup 반영 (mcp-sync.js 수정)
- [x] 실측 EXIST 67개 확인
- [x] 보류 전부 GO/NO 확정 (보류 0)
- [x] 기능적 중복 교차 검증 + 통합 매핑
- [x] GO 51개 카테고리별 정리 + clone 명령
- [ ] 실제 다운로드 + skills_ref/ 복사
- [ ] registry.json 업데이트
