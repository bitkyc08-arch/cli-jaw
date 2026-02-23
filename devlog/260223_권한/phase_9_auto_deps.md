# Phase 9 — 스킬 의존성 자동 설치

## 개요

Codex 스킬의 8개가 Python/uv에 의존하고, Phase 7 브라우저 스킬은 playwright-core에 의존.
`npm install cli-claw` 시 이 의존성들을 자동으로 설치해서 사용자 경험을 개선.

---

## 의존성 매핑

| 의존성              | 필요한 스킬                                                                   | 설치 방법                                          |
| ------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| **uv**              | imagegen, pdf, speech, spreadsheet, transcribe, sora, jupyter-notebook, atlas | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **playwright-core** | browser (Phase 7)                                                             | `npm i -g playwright-core`                         |
| **Google Chrome**   | browser (Phase 7)                                                             | 수동 설치                                          |
| **gh** (GitHub CLI) | yeet, gh-address-comments, gh-fix-ci                                          | `brew install gh`                                  |
| **cliclick**        | browser 좌표 기반 (optional)                                                  | `brew install cliclick`                            |

> 자동 설치: uv, playwright-core
> 수동 설치: Chrome, gh, cliclick (doctor에서 안내)

---

## 구현

### [MODIFY] `bin/postinstall.js`

Step 8 추가 — 스킬 의존성 자동 설치:

```js
const SKILL_DEPS = [
    {
        name: 'uv',
        check: 'uv --version',
        install: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
        why: 'Python skills (imagegen, pdf, speech, spreadsheet, transcribe)',
    },
    {
        name: 'playwright-core',
        check: 'node -e "require.resolve(\'playwright-core\')"',
        install: 'npm i -g playwright-core',
        why: 'Browser control skill (cli-claw browser)',
    },
];
```

동작:
1. `which uv` / `require.resolve` 로 존재 확인
2. 없으면 자동 설치 시도
3. 실패 시 수동 설치 안내 출력 (에러 아님, 경고만)

### [MODIFY] `bin/commands/doctor.js`

Check 9 추가:

```
✅ uv (Python): uv 0.5.19
✅ playwright-core: installed
✅ Google Chrome: installed
```

또는:

```
⚠️ uv (Python): not installed — run: curl -LsSf https://astral.sh/uv/install.sh | sh
⚠️ playwright-core: not installed — run: npm i -g playwright-core
⚠️ Google Chrome: not found — required for browser skill
```

---

## 체크리스트

- [x] `bin/postinstall.js` — uv + playwright-core 자동 설치
- [x] `bin/commands/doctor.js` — uv, playwright-core, Chrome 체크
- [x] devlog 문서화
