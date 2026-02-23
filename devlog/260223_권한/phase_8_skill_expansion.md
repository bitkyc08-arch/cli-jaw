# Phase 8 — 스킬 확장 (OpenClaw 내장 도구 → cli-claw 스킬 변환)

## 개요

OpenClaw은 19개의 내장 agent tool을 코드로 구현.
cli-claw은 agent tool 주입이 불가능하므로(CLI spawn 구조), **스킬(SKILL.md) + shell 명령**으로 동일한 기능을 제공.

Phase 7에서 browser를 성공적으로 스킬화한 패턴을 적용.

---

## OpenClaw 내장 도구 전수 분석

### 이미 cli-claw에 있는 것 (구현 불필요)

| OpenClaw Tool     | cli-claw 대응                  | 상태         |
| ----------------- | ------------------------------ | ------------ |
| **browser**       | `cli-claw browser` + SKILL.md  | ✅ Phase 7    |
| **cron**          | heartbeat.json 시스템          | ✅ Phase 2    |
| **subagents**     | orchestrator (subtask JSON)    | ✅ Phase 4    |
| **sessions-send** | orchestrator dispatch          | ✅ Phase 4    |
| **message**       | Telegram 통합                  | ✅ Phase 3    |
| **gateway**       | `cli-claw serve/status/doctor` | ✅ Phase 9    |
| **memory**        | (별도 진행 예정)               | 🔜 별도 Phase |

### 스킬화 불필요 (내부 인프라)

| OpenClaw Tool                   | 이유                                    |
| ------------------------------- | --------------------------------------- |
| **sessions-list/history/spawn** | Gateway 세션 관리. cli-claw은 단일 서버 |
| **session-status**              | `cli-claw status`로 대체                |
| **agents-list**                 | DB employees 테이블로 대체              |
| **nodes**                       | 원격 노드/카메라. 하드웨어 특화         |

---

## 8.1 TTS 스킬 (SKILL.md only)

### ✅ 완료

macOS 내장 `say` 명령 사용. 코드 변경 없음.

#### [NEW] `skills_ref/tts/SKILL.md`

```
say "Hello world"                    # 즉시 재생
say -v Yuna "안녕하세요"              # 한국어 음성
say -o ~/output.aiff "Hello"         # 파일 저장
say -r 200 "Fast speech"             # 속도 조절
```

추가 지원:
- 다국어 음성 (Yuna, Samantha, Daniel, Kyoko...)
- 파일 출력 + ffmpeg 변환 (MP3, WAV, OGG)
- sherpa-onnx 고품질 TTS (optional)

---

## 8.2 Screen Capture 스킬 (SKILL.md only)

### ✅ 완료

macOS 내장 `screencapture` 사용. 코드 변경 없음.

#### [NEW] `skills_ref/screen-capture/SKILL.md`

```
screencapture -x ~/screenshot.png              # 전체 화면 (무음)
screencapture -i ~/selection.png               # 영역 선택
screencapture -R 0,0,1280,720 ~/region.png     # 좌표 지정
screencapture -l$(osascript -e '...') ~/app.png # 특정 앱 창
screencapture -v ~/recording.mov               # 화면 녹화
```

추가 지원:
- 웹캠 캡처 (imagesnap, optional `brew install imagesnap`)
- 클립보드 복사 (`-c`)
- 다중 디스플레이 캡처
- 비디오 녹화 (`-v`, `-V seconds`)

---

## 8.3 Image 생성/분석 — nano-banana-pro 통합

### 현재 상태

`nano-banana-pro` 스킬이 이미 존재:
- Gemini 3 Pro Image로 이미지 생성/편집
- `uv run {baseDir}/scripts/generate_image.py` 사용
- `GEMINI_API_KEY` 필요
- 해상도: 1K, 2K, 4K
- 멀티 이미지 합성 (최대 14장)

### 문제점

1. **이미지 분석이 없음** — 생성만 가능, 비전 분석(이미지 보고 설명) 미지원
2. **OpenClaw 경로 의존** — `{baseDir}` 변수가 OpenClaw 구조 전제
3. **screencapture와 연계 없음** — 캡처 → 분석 워크플로우 불가

### 통합 방향

`nano-banana-pro`를 **확장**하거나, 새 `image` 스킬로 통합:

#### 옵션 A: nano-banana-pro 확장 (추천)

기존 스킬에 비전 분석 + screencapture 연계 추가:

```bash
# 기존 (생성)
cli-claw image generate "A sunset over the ocean" --resolution 2K

# 추가 (분석)
cli-claw image analyze ~/screenshot.png "What does this show?"
cli-claw image analyze ~/photo.jpg "Extract all text from this image"

# 추가 (워크플로우: 캡처 + 분석)
cli-claw image capture --analyze "What's on screen?"
```

#### 옵션 B: 통합 image 스킬 (대체)

nano-banana-pro를 image로 rename하고 모든 기능 통합.

### 추가할 것

#### [MODIFY] `skills_ref/nano-banana-pro/SKILL.md` 또는 [NEW] `skills_ref/image/SKILL.md`

기존 생성 기능 유지 + 비전 분석 추가:

```yaml
---
name: image
description: "AI image generation (Gemini 3 Pro) and vision analysis. Generate, edit, and analyze images."
metadata:
  openclaw:
    emoji: "🖼️"
    requires:
      bins: ["uv"]
      env: ["GEMINI_API_KEY"]
---
```

#### [NEW] `src/image.js` (~150줄)

```js
// Gemini multimodal API 호출
// 1. 이미지 생성: generateContent with image generation config
// 2. 비전 분석: generateContent with image input + text prompt
// 3. 이미지 편집: generateContent with source image + edit prompt

export async function generateImage(prompt, opts) {
    // Gemini API → base64 이미지 → 파일 저장
}

export async function analyzeImage(imagePath, prompt) {
    // 이미지 → base64 → Gemini API with vision
}

export async function editImage(imagePath, prompt, opts) {
    // 기존 nano-banana-pro 스크립트 호출 또는 직접 API
}
```

#### [NEW] `bin/commands/image.js` (~100줄)

```
cli-claw image generate <prompt> [--resolution 1K|2K|4K] [--filename out.png]
cli-claw image analyze <path> [prompt]
cli-claw image edit <path> <prompt> [--resolution 2K]
cli-claw image capture [--analyze <prompt>]   # screencapture → analyze 파이프라인
```

#### [MODIFY] `server.js`

```
POST /api/image/generate   { prompt, resolution, filename }
POST /api/image/analyze    { path, prompt }
POST /api/image/edit       { path, prompt, resolution }
```

### nano-banana-pro 스크립트 재사용 여부

| 방식                                         | 장점                            | 단점           |
| -------------------------------------------- | ------------------------------- | -------------- |
| 스크립트 재사용 (`uv run generate_image.py`) | 검증된 코드, 즉시 사용          | Python/uv 의존 |
| Node.js 직접 구현 (`fetch` → Gemini API)     | Node.js만으로 동작, 의존성 감소 | 새로 짜야 함   |

> **추천**: Node.js 직접 구현 (`fetch` only). `uv`/Python 의존 제거되어 설치가 단순해짐.
> Gemini API는 REST 기반이라 `fetch`만으로 충분.

### Gemini API 직접 호출 예시

```js
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

// 이미지 생성
async function generateImage(prompt, apiKey) {
    const resp = await fetch(
        `${GEMINI_API}/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
            }),
        }
    );
    const data = await resp.json();
    // data.candidates[0].content.parts → { inlineData: { mimeType, data(base64) } }
    return data;
}

// 비전 분석
async function analyzeImage(imagePath, prompt, apiKey) {
    const imageData = fs.readFileSync(imagePath).toString('base64');
    const resp = await fetch(
        `${GEMINI_API}/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { inlineData: { mimeType: 'image/png', data: imageData } },
                        { text: prompt || 'Describe this image in detail.' },
                    ],
                }],
            }),
        }
    );
    return resp.json();
}
```

### 파일 변경

| 파일                        | 유형   | 줄 수 |
| --------------------------- | ------ | ----- |
| `skills_ref/image/SKILL.md` | NEW    | ~60   |
| `src/image.js`              | NEW    | ~150  |
| `bin/commands/image.js`     | NEW    | ~100  |
| `server.js`                 | MODIFY | +30   |
| `bin/cli-claw.js`           | MODIFY | +3    |
| `registry.json`             | MODIFY | +10   |

### 환경 변수

```
GEMINI_API_KEY=your_key_here
```

`settings.json`에서도 설정 가능:
```json
{
    "image": {
        "apiKey": "your_key_here",
        "defaultResolution": "1K",
        "model": "gemini-2.0-flash-exp"
    }
}
```

---

## 실행 순서

```
8.1 TTS SKILL.md              ← ✅ 완료 (코드 0줄)
    ↓
8.2 Screen Capture SKILL.md   ← ✅ 완료 (코드 0줄)
    ↓
8.3 Image 생성/분석            ← Node.js fetch 기반 (~280줄 새 코드)
    ↓
(Memory는 별도 Phase)
```

## 체크리스트

### Phase 8.1: TTS ✅
- [x] `skills_ref/tts/SKILL.md` — macOS say + sherpa-onnx 사용법
- [x] `registry.json`에 tts 추가

### Phase 8.2: Screen Capture ✅
- [x] `skills_ref/screen-capture/SKILL.md` — screencapture + imagesnap
- [x] `registry.json`에 screen-capture 추가

### Phase 8.3: Image 생성/분석
- [ ] `skills_ref/image/SKILL.md` — 생성/분석/편집 통합 사용법
- [ ] `src/image.js` — Gemini API fetch 호출 (생성 + 비전)
- [ ] `bin/commands/image.js` — generate/analyze/edit/capture CLI
- [ ] `server.js`에 `/api/image/*` 라우트
- [ ] `bin/cli-claw.js`에 image case
- [ ] `registry.json`에 image 추가
- [ ] `GEMINI_API_KEY` 환경변수 / settings 지원
- [ ] nano-banana-pro 스킬 deprecation 표시 또는 image로 redirect
