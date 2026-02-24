---
created: 2026-02-24
tags: [vision, codex, gpt-5.3, 좌표추출, 스모크테스트]
status: verified
---

# (fin) Vision Click — Codex CLI 방식

> `codex exec -i screenshot.png --json` — **±1px 정확도 검증 완료.**

---

## 핵심 요약

| 항목            | 값                               |
| --------------- | -------------------------------- |
| **CLI 명령**    | `codex exec -i <image> --json`   |
| **이미지 전달** | `--image` / `-i` 네이티브 플래그 |
| **출력 형식**   | `--json` (NDJSON stream)         |
| **정확도**      | ±1px (LOGIN 버튼 테스트)         |
| **모델**        | GPT-5.3-Codex (기본)             |
| **추천도**      | ⭐⭐⭐⭐⭐ — **cli-claw 메인 방식**   |

---

## 스모크 테스트 결과

### 테스트 1: LOGIN 버튼 (800×600 UI)

```bash
codex exec -i /tmp/vision-test-ui.png --json \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  'This is a screenshot (800x600px). Find the "LOGIN" button.
   Return ONLY JSON: { "found": true, "x": center_x, "y": center_y, "description": "..." }'
```

**결과:**
```json
{"found":true,"x":400,"y":276,"description":"Blue rectangular button labeled 'LOGIN' near the center of the screen, above the red 'SIGNUP' button."}
```

| 항목    | 실제 | 반환 | 오차    |
| ------- | ---- | ---- | ------- |
| LOGIN x | 400  | 400  | **0px** |
| LOGIN y | 275  | 276  | **1px** |

### 테스트 2: SIGNUP 버튼 (한국어 프롬프트)

```bash
codex exec -i /tmp/vision-test-ui.png --json \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  '"SIGNUP" 버튼의 중심 좌표를 찾아줘. JSON만 반환.'
```

**결과:**
```json
{"found":true,"x":400,"y":345,"description":"\"SIGNUP\" 빨간 버튼 영역(대략 x=300~500, y=320~370)의 중심 좌표"}
```

> [!TIP]
> Codex는 이미지만으로 좌표를 바로 반환하지 않고, **PIL 스크립트를 실행해서 픽셀을 분석**한 뒤 중심 좌표를 계산함. 즉 비전 + 코드 실행을 결합하는 에이전틱 패턴.

| 항목     | 실제 | 반환 | 오차    |
| -------- | ---- | ---- | ------- |
| SIGNUP x | 400  | 400  | **0px** |
| SIGNUP y | 345  | 345  | **0px** |

---

## cli-claw 통합 구현

### `buildArgs`에 `--image` 추가

```javascript
// agent.js buildArgs() - codex case에 이미지 지원 추가
case 'codex':
    return ['exec',
        ...(model && model !== 'default' ? ['-m', model] : []),
        ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
        ...(opts.imagePath ? ['-i', opts.imagePath] : []),   // ← 추가
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check', '--json'];
```

### Vision Click 전용 함수

```javascript
// src/browser/vision.js — Codex CLI 방식
import { spawn } from 'child_process';
import { screenshot } from './actions.js';

export async function visionClickCodex(port, target, opts = {}) {
    // 1. 스크린샷 저장
    const screenshotPath = `/tmp/claw-vision-${Date.now()}.png`;
    const page = await getActivePage(port);
    await page.screenshot({ path: screenshotPath, type: 'png' });
    const viewport = page.viewportSize() || { width: 1280, height: 720 };

    // 2. Codex CLI로 좌표 추출
    const result = await new Promise((resolve, reject) => {
        const child = spawn('codex', [
            'exec',
            '-i', screenshotPath,
            '--json',
            '--dangerously-bypass-approvals-and-sandbox',
            '--skip-git-repo-check',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        const prompt = `This screenshot is ${viewport.width}x${viewport.height}px.
Find "${target}" and return ONLY JSON:
{ "found": bool, "x": int, "y": int, "description": "..." }
Do NOT write any files.`;
        child.stdin.write(prompt);
        child.stdin.end();

        let buffer = '';
        child.stdout.on('data', chunk => buffer += chunk);
        child.on('close', () => {
            // NDJSON에서 agent_message 타입 찾기
            const lines = buffer.split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const event = JSON.parse(line);
                    if (event.item?.type === 'agent_message') {
                        resolve(JSON.parse(event.item.text));
                        return;
                    }
                } catch {}
            }
            reject(new Error('No coordinate response from Codex'));
        });
    });

    if (!result.found) return { success: false, error: `"${target}" not found` };

    // 3. 클릭
    if (opts.doubleClick) await page.mouse.dblclick(result.x, result.y);
    else await page.mouse.click(result.x, result.y);

    // 4. 정리
    const fs = await import('fs');
    fs.unlinkSync(screenshotPath);

    return { success: true, clicked: { x: result.x, y: result.y }, description: result.description };
}
```

---

## 장점과 한계

| 장점                             | 한계                                 |
| -------------------------------- | ------------------------------------ |
| `-i` 네이티브 이미지 플래그      | Codex CLI가 설치되어 있어야 함       |
| ±1px 정확도 (스모크 테스트 검증) | 코드 실행으로 좌표 계산 → 2~5초 소요 |
| `--json` NDJSON 스트리밍         | input_tokens ~18K (이미지 포함)      |
| 에이전틱 패턴 (비전 + PIL 결합)  | 비용 ~$0.005~0.01/호출               |
| 한국어 프롬프트 지원             | sandbox 설정 필요                    |

---

## 변경 기록

- 2026-02-24: 스모크 테스트 완료. LOGIN ±1px, SIGNUP ±0px.
