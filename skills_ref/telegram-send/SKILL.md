---
name: telegram-send
description: "Send voice/photos/documents (and optional text notices) to Telegram. Use local api first, then Bot API fallback if file-send fails."
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

Use this skill when the user asks to deliver non-text output to Telegram.
Keep your normal text response in stdout.

## Primary Endpoint

`POST http://localhost:3457/api/telegram/send`

## Supported Types

- `voice`
- `photo`
- `document`
- `text` (optional status message)

## Request Rules

- For non-text types, `file_path` is required.
- `chat_id` is optional for local endpoint (server uses latest active chat).
- For Bot API fallback, `chat_id` is required.

## Standard Call (Use First)

```bash
curl -sS -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"photo","file_path":"/tmp/chart.png","caption":"Analysis chart"}'
```

## Failure Pattern and Fallback

If local endpoint returns file-send failure (for example `{"error":"Unexpected end of JSON input"}`) for `photo/voice/document`, use direct Telegram Bot API.

### 1) Read token and chat id

```bash
TOKEN=$(jq -r '.telegram.token' ~/.cli-claw/settings.json)
CHAT_ID=8231528245   # or provide from user/previous successful response
```

If `CHAT_ID` is unknown, fetch the latest one:

```bash
CHAT_ID=$(curl -sS -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"text","text":"chat_id check"}' | jq -r '.chat_id')
```

### 2) Send by type

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

## Quick Verification

```bash
curl -sS -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"text","text":"ping"}'
```

## Safety Note

- Do not print token values in logs or chat output.
- Read token only via `jq` variable assignment and use it in-process.

Expected success shape:

```json
{"ok":true,"chat_id":8231528245,"type":"text"}
```
