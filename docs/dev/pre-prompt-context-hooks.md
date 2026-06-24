# Pre-Prompt Context Hooks

The V1 hook supplies small, current operational facts before model reasoning.
It is a state injection boundary, not an executable automation interface and
not a replacement for the system prompt, skills, or durable memory.

## Configuration

Create `context-hooks.json` in `CLI_JAW_HOME`:

```json
{
  "version": 1,
  "enabled": true,
  "includeTurnMetadata": true,
  "limits": {
    "maxSources": 5,
    "maxTotalChars": 3000,
    "maxSourceChars": 1200
  },
  "sources": [
    {
      "id": "current-mode",
      "path": "data/current-mode.json",
      "scopes": ["main", "heartbeat"],
      "fields": ["mode", "recordRequired", "recordReason"],
      "maxAgeSeconds": 900
    },
    {
      "id": "ac-policy",
      "path": "data/ac-policy.json",
      "scopes": ["heartbeat"],
      "jobs": ["ac-guard"],
      "fields": ["completionOutput", "notifyOnChange"],
      "maxAgeSeconds": 86400
    }
  ]
}
```

Paths must be relative to `CLI_JAW_HOME`. Each source must be a JSON object and
must declare a non-empty field allowlist. The process that owns a runtime fact
is responsible for updating its JSON snapshot; the hook itself never writes
state.

## Boundaries

- No shell commands, scripts, network requests, or arbitrary modules.
- Source paths and resolved symlinks cannot escape `CLI_JAW_HOME`.
- Files larger than 64 KiB are rejected.
- Configured limits are capped at 8 sources, 4,000 total characters, and 1,500
  characters per source.
- Missing, stale, malformed, or oversized sources are skipped independently.
- Values are JSON serialized and labeled as untrusted data rather than
  instructions.
- `CLI_JAW_PRE_PROMPT_HOOKS=0` is the emergency kill switch.

These controls reduce prompt injection and latency risk, but they do not make
an untrusted producer authoritative. Register only locally controlled state
files and expose the minimum fields needed for a decision.

## Inspection

```bash
jaw hooks inspect
jaw hooks inspect --scope heartbeat --job ac-guard --json
```

The command reports included, stale, invalid, out-of-scope, and over-budget
sources and prints the exact prompt block. A configured prompt build also emits
one bounded summary log line prefixed with `[jaw:hook:pre-prompt]`.

If the configuration file is absent, disabled, invalid, or killed through the
environment variable, prompt construction continues without hook content.
