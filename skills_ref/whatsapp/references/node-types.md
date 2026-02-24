# Workflow Node Types

## Supported node_type values

These are the `data.node_type` values supported by the Platform API and validated by `scripts/validate-graph.js`:

- `start`
- `send_text`
- `send_template`
- `send_interactive`
- `wait_for_response`
- `set_variable`
- `decide`
- `call`
- `webhook`
- `pipedream`
- `function`
- `agent`
- `handoff`

Messaging nodes are `send_text`, `send_template`, and `send_interactive`.

Node structure:

```json
{
  "id": "send_text_1710000000000",
  "type": "flow-node",
  "position": { "x": 300, "y": 100 },
  "data": {
    "node_type": "send_text",
    "config": {},
    "display_name": "Send Text"
  }
}
```

Notes:
- `display_name` is computed by the backend and is not reliably editable.
- New node IDs should use `{node_type}_{timestamp_ms}`.
- Nodes connect from bottom to top; organize the graph vertically (top-down) rather than left-to-right.

## start

```json
{ "node_type": "start", "config": {} }
```

Exactly one start node per workflow, id must be `start`.

## send_text

```json
{ "node_type": "send_text", "config": { "message": "Hello {{vars.name}}!", "delay_seconds": 0 } }
```

Optional: `whatsapp_config_id`, `to_phone_number`.

## send_template

```json
{
  "node_type": "send_template",
  "config": {
    "template_id": "uuid",
    "parameters": { "1": "{{vars.name}}" }
  }
}
```

Optional: `whatsapp_config_id`, `to_phone_number`.
Use the `integrate-whatsapp` skill to find template IDs and parameter formats.

## send_interactive (buttons)

```json
{
  "node_type": "send_interactive",
  "config": {
    "interactive_type": "button",
    "body_text": "Choose an option:",
    "buttons": [
      { "id": "yes", "title": "Yes" },
      { "id": "no", "title": "No" }
    ]
  }
}
```

Max 3 buttons; id + title required (title max 20 chars).

## send_interactive (list)

```json
{
  "node_type": "send_interactive",
  "config": {
    "interactive_type": "list",
    "body_text": "Select:",
    "list_button_text": "View options",
    "list_sections": [
      { "title": "Section", "rows": [{ "id": "opt1", "title": "Option 1" }] }
    ]
  }
}
```

## send_interactive (cta_url)

```json
{
  "node_type": "send_interactive",
  "config": {
    "interactive_type": "cta_url",
    "body_text": "Visit our site",
    "cta_display_text": "Open",
    "cta_url": "https://example.com"
  }
}
```

## send_interactive (flow)

```json
{
  "node_type": "send_interactive",
  "config": {
    "interactive_type": "flow",
    "body_text": "Open calendar",
    "flow_id": "<META_FLOW_ID>",
    "flow_cta": "Open",
    "flow_action": "navigate",
    "flow_action_payload": { "screen": "FIRST_SCREEN" }
  }
}
```

Notes:
- `flow_id` is the Meta Flow ID (string).
- `flow_action_payload.screen` must be a valid first screen.

## wait_for_response

```json
{ "node_type": "wait_for_response", "config": { "save_response_to": "user_reply" } }
```

Saves the next message into `vars.user_reply`.

## set_variable

```json
{
  "node_type": "set_variable",
  "config": {
    "variable_name": "customer_name",
    "variable_value": "{{vars.user_reply}}",
    "value_type": "string"
  }
}
```

Notes:
- Use `value_type: "string"` unless you have a specific reason to store a different type.

## decide (AI routing)

```json
{
  "node_type": "decide",
  "config": {
    "decision_type": "ai",
    "provider_model_id": "uuid",
    "conditions": [
      { "label": "interested", "description": "User shows interest" },
      { "label": "not_interested", "description": "User declines" }
    ]
  }
}
```

## decide (function routing)

```json
{
  "node_type": "decide",
  "config": {
    "decision_type": "function",
    "function_id": "uuid",
    "conditions": [
      { "label": "yes", "description": "Approved" },
      { "label": "no", "description": "Rejected" }
    ]
  }
}
```

Rules:
- Outgoing edge labels must match `conditions[].label`.
- When creating new conditions, do not include an `id` field.

## call (subworkflow)

```json
{ "node_type": "call", "config": { "workflow_id": "uuid", "save_error_to": "subflow_error" } }
```

## webhook

```json
{
  "node_type": "webhook",
  "config": {
    "url": "https://api.example.com/endpoint",
    "method": "POST",
    "headers": { "Authorization": "Bearer {{vars.token}}" },
    "body_template": { "phone": "{{context.phone_number}}" },
    "save_response_to": "api_result"
  }
}
```

`headers` and `body_template` must be valid JSON objects.

## pipedream (apps)

```json
{
  "node_type": "pipedream",
  "config": {
    "action_id": "slack-send_message_to_channel",
    "app_slug": "slack",
    "account_id": "apn_example",
    "configured_props": {
      "channel": "#general",
      "text": "Hello {{vars.user_name}}!"
    },
    "dynamic_props_id": "dp_optional",
    "save_response_to": "app_result"
  }
}
```

Notes:
- Use `references/app-integrations.md` for how to find `action_id`, `account_id`, and build `configured_props`.
- `configured_props` may include `{{vars.*}}`, `{{system.*}}`, `{{context.*}}` runtime variables.

## function

```json
{ "node_type": "function", "config": { "function_id": "uuid", "save_response_to": "fn_result" } }
```

Use `automate-whatsapp` function scripts to find function IDs and update code.

## agent

```json
{
  "node_type": "agent",
  "config": {
    "system_prompt": "You are a helpful assistant...",
    "provider_model_id": "uuid",
    "max_iterations": 10,
    "temperature": 0.7
  }
}
```

Notes:
- `provider_model_id` is required. Use `scripts/list-provider-models.js` to find it.
- Agent tool arrays live inside `data.config` (not at the `data` root).

Default tools (toggle on/off only):
- complete_task (required)
- handoff_to_human (required)
- send_notification_to_user
- send_media
- get_execution_metadata
- get_whatsapp_context
- get_current_datetime
- save_variable
- get_variable
- ask_about_file

Custom tools:
- `flow_agent_app_integration_tools[]` (app integrations)
- `flow_agent_webhooks[]` (webhook tools)
- `flow_agent_mcp_servers[]` (MCP tools)

### Agent tools: exact placement and structure

All tool arrays go under `data.config` of the agent node:

```json
{
  "id": "agent_1730000000000",
  "type": "flow-node",
  "position": { "x": 120, "y": 320 },
  "data": {
    "node_type": "agent",
    "config": {
      "system_prompt": "You can schedule appointments and use calendar tools.",
      "provider_model_id": "uuid",
      "max_iterations": 10,
      "temperature": 0.7,
      "flow_agent_app_integration_tools": [],
      "flow_agent_webhooks": [],
      "flow_agent_mcp_servers": []
    }
  }
}
```

Example asset: `assets/agent-app-integration-example.json`

#### App integration tools (preferred for agent nodes)

Use pre-configured integrations and attach them as tools:

```json
{
  "flow_agent_app_integration_tools": [
    {
      "name": "check_calendar",
      "description": "Check availability in Google Calendar",
      "app_integration_id": "integration_uuid"
    }
  ]
}
```

Rules:
- `app_integration_id` is the integration UUID from `scripts/list-integrations.js`.
- Do not include headers or URLs here; the integration handles auth.
- Inputs are defined by the integration's `variable_definitions` (or `{{placeholders}}`).

Tool input payload (runtime):
```json
{
  "input": {
    "calendar_id": "primary",
    "time_min": "2025-01-01T10:00:00Z",
    "time_max": "2025-01-01T12:00:00Z"
  }
}
```

#### Webhook tools (custom HTTP tools)

Use when the agent needs to call arbitrary HTTP endpoints:

```json
{
  "flow_agent_webhooks": [
    {
      "name": "lookup_customer",
      "description": "Fetch customer data from internal API",
      "url": "https://api.example.com/customers/lookup",
      "http_method": "POST",
      "headers": {
        "Authorization": "Bearer {{vars.api_token}}",
        "Content-Type": "application/json"
      },
      "body": {
        "phone_number": "{{context.phone_number}}"
      },
      "body_schema": {
        "type": "object",
        "properties": {
          "phone_number": { "type": "string" }
        },
        "required": ["phone_number"]
      },
      "jmespath_query": null
    }
  ]
}
```

Rules:
- `body_schema` must be valid JSON Schema.
- `headers` and `body` must be JSON objects (not strings).
- Tool inputs are defined by `body_schema` and are sent as the webhook JSON body.

#### MCP server tools

Use to attach MCP servers the agent can call:

```json
{
  "flow_agent_mcp_servers": [
    {
      "name": "files",
      "description": "Local file access",
      "url": "https://mcp.example.com",
      "headers": {
        "Authorization": "Bearer {{vars.mcp_token}}"
      }
    }
  ]
}
```

Rules:
- `url` is required.
- `headers` must be a JSON object.
- MCP tool inputs are defined by the MCP server's tool schemas (not configured here).

## handoff

```json
{ "node_type": "handoff", "config": {} }
```

Ends execution and flags for human takeover.

## AI Fields (dynamic content)

Set a field to `{"$ai":{}}` and add `ai_field_config`:

```json
{
  "message": { "$ai": {} },
  "provider_model_id": "uuid",
  "ai_field_config": {
    "message": { "mode": "prompt", "prompt": "Write a greeting for {{vars.name}}" }
  }
}
```
