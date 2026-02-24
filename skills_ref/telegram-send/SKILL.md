---
name: telegram-send
description: "Send voice/photos/documents (and optional text notices) directly to Telegram via local cli-claw API."
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "requires": { "bins": ["curl"] },
      },
  }
---

# Telegram Send

Use this skill when the user asks to deliver non-text output to Telegram.
This is separate from the normal text response pipeline.

## Endpoint

`POST http://localhost:3457/api/telegram/send`

## Supported Types

- `voice`
- `photo`
- `document`
- `text` (optional, for intermediate notices)

## Request Rules

- For non-text types, `file_path` is required.
- `chat_id` is recommended. If omitted, server uses the latest active Telegram chat.
- Keep your normal text response in stdout (do not replace it with file send only).

## Examples

```bash
# Send voice (OGG/OPUS recommended, MP3/M4A also allowed by Telegram)
curl -s -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"voice","file_path":"/tmp/reply.ogg","caption":"Voice response"}'

# Send photo
curl -s -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"photo","file_path":"/tmp/chart.png","caption":"Analysis chart"}'

# Send document
curl -s -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"document","file_path":"/tmp/report.pdf","caption":"Weekly report"}'

# Optional text notice
curl -s -X POST http://localhost:3457/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"type":"text","text":"Intermediate result is ready"}'
```
