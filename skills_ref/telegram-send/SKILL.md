---
name: telegram-send
description: "Send voice/photos/documents (and optional text notices) to Telegram. Prefer Bot API first for non-text delivery; use local API for text/status and fallback."
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "requires": { "bins": ["curl", "jq"] },
      },
  }
---

# Telegram Send

Use this skill when the user asks to deliver output to Telegram.
Keep your normal text response in stdout.

## Delivery Policy (Bot-First)

- `photo`/`voice`/`document`: send with direct Telegram Bot API first.
- `text` status notices: you may use local endpoint for convenience.
- If Bot API send fails, you can retry once via local endpoint.

## Required Inputs

- Non-text requires `file_path`.
- Bot API requires `chat_id`.
- Token is read from `~/.cli-claw/settings.json`.

## 1) Read token and chat id

```bash
TOKEN=$(jq -r '.telegram.token' ~/.cli-claw/settings.json)
CHAT_ID=8231528245   # user-provided or previously known
```

If `CHAT_ID` is unknown, recover latest active chat via local endpoint text ping:

```bash
CHAT_ID=$(curl -sS -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"text","text":"chat_id check"}' | jq -r '.chat_id')
```

## 2) Bot API send by type (Primary)

```bash
# photo
curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/sendPhoto" \
  -F "chat_id=${CHAT_ID}" \
  -F "photo=@/tmp/chart.png" \
  -F "caption=Analysis chart"

# voice
curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/sendVoice" \
  -F "chat_id=${CHAT_ID}" \
  -F "voice=@/tmp/reply.ogg" \
  -F "caption=Voice response"

# document
curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/sendDocument" \
  -F "chat_id=${CHAT_ID}" \
  -F "document=@/tmp/report.pdf" \
  -F "caption=Weekly report"
```

## 3) Local Endpoint (Secondary)

Primary local endpoint:

`POST http://localhost:3457/api/telegram/send`

Example (non-text):

```bash
curl -sS -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"photo","file_path":"/tmp/chart.png","caption":"Analysis chart"}'
```

## Quick Verification

```bash
curl -sS -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"text","text":"ping"}'
```

## Safety Note

- Do not print token values in logs or chat output.
- Keep token in shell variables only.

Expected success shape:

```json
{"ok":true,"chat_id":8231528245,"type":"text"}
```
