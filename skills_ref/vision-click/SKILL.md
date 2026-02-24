---
name: vision-click
description: "Vision-based coordinate click: screenshot → AI coordinate extraction → mouse click. Codex CLI only."
metadata:
  openclaw:
    emoji: "👁️"
    requires:
      bins: ["codex", "cli-claw"]
      system: ["Google Chrome"]
---

# Vision Click (Codex Only)

Click non-DOM elements by screenshot analysis.
Uses `codex exec -i` for vision-based coordinate extraction.

## Prerequisites

- **Codex CLI** installed and authenticated
- cli-claw server running (`cli-claw serve`)
- Browser started (`cli-claw browser start`)

## When to Use

Use when `cli-claw browser snapshot` returns **NO ref** for target:
- Canvas elements, iframes, Shadow DOM
- Dynamically rendered content (WebGL, SVG)
- Elements behind overlays or custom web components

> **Always try `snapshot` first.** Only fall back to vision-click if no ref exists.

## Workflow

```
1. cli-claw browser snapshot        → Check if target has a ref ID
2. If ref exists → cli-claw browser click <ref>  (normal path)
3. If NO ref → vision-click fallback:
   a. cli-claw browser screenshot   → Save screenshot (check output for path)
   b. codex exec -i <screenshot_path> --json \
        --dangerously-bypass-approvals-and-sandbox \
        --skip-git-repo-check \
        'Screenshot is WxHpx. Find "<TARGET>" center pixel coordinate. \
         Return ONLY JSON: {"found":true,"x":int,"y":int,"description":"..."}'
   c. Parse JSON response for x, y coordinates
   d. cli-claw browser mouse-click <x> <y>
   e. cli-claw browser snapshot     → Verify click worked
```

## Commands

### Screenshot + Vision

```bash
# 1. Take screenshot
cli-claw browser screenshot
# Output: { path: "/path/to/screenshot.png", ... }

# 2. Extract coordinates with Codex vision
codex exec -i /path/to/screenshot.png --json \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  'Screenshot is 1280x720px. Find "Submit" button center pixel coordinate.
   Return ONLY JSON: {"found":true,"x":640,"y":400,"description":"blue submit button"}'

# 3. Click at coordinates
cli-claw browser mouse-click 640 400

# 4. Verify
cli-claw browser snapshot
```

### Mouse Click (pixel coordinates)

```bash
cli-claw browser mouse-click <x> <y>          # Single click
# Double-click via API:
curl -X POST http://localhost:3457/api/browser/act \
  -H 'Content-Type: application/json' \
  -d '{"kind":"mouse-click","x":640,"y":400,"doubleClick":true}'
```

## Parsing Codex Response

Codex `--json` outputs NDJSON. Look for `item.type === "agent_message"`:

```javascript
// Parse NDJSON stream
const lines = stdout.split('\n').filter(l => l.trim());
for (const line of lines) {
    const event = JSON.parse(line);
    if (event.item?.type === 'agent_message') {
        const coords = JSON.parse(event.item.text);
        // coords = { found: true, x: 640, y: 400, description: "..." }
    }
}
```

## Accuracy

Verified via smoke test (2026-02-24):

| Target                  | Actual     | Codex Result | Error |
| ----------------------- | ---------- | ------------ | ----- |
| LOGIN button (800×600)  | (400, 275) | (400, 276)   | ±1px  |
| SIGNUP button (800×600) | (400, 345) | (400, 345)   | ±0px  |

## Limitations

- **Codex CLI only** — Gemini/Claude CLI cannot pass images
- Latency: 2-5 seconds per vision call
- Cost: ~$0.005-0.01 per call (~18K input tokens)
- Complex UIs may need confidence check + retry
- DPR (device pixel ratio) scaling not handled in Phase 1
