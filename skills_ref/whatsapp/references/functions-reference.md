# Function Runtime Contract

## Handler signature

Functions must start with:

```
async function handler(request, env) {
```

Do not use `export` or arrow functions. Return a `Response` object.

## Runtime APIs

- `request`: Fetch API Request; use `await request.json()` for JSON.
- `env.DB`: D1 database access (if enabled for the project).
- `env.KV`: KV storage with `.get(key)`, `.put(key, value)`, `.delete(key)`.
- `env.SECRET_NAME`: Secrets configured in the function settings.

## Typical workflow

1. Create function with `code` that follows the contract.
2. Deploy the function (required before use).
3. Use the returned `function_url` for webhook destinations.

## Platform API payload envelope

When calling the Platform API directly (not via scripts), wrap attributes under `function`:

```json
{ "function": { "name": "...", "description": "...", "code": "..." } }
```

## Workflow node payload (Function / Decide)

When a workflow function node runs, Kapso sends:

```json
{
  "execution_context": {
    "vars": { "user_name": "John", "score": 42 },
    "system": { "flow_id": "uuid", "flow_name": "...", "trigger_type": "inbound_message" },
    "context": { "channel": "whatsapp", "phone_number": "+1234567890", "contact": { "wa_id": "...", "profile_name": "..." } },
    "metadata": { "request": { "ip": "...", "timestamp": "..." } }
  },
  "available_edges": ["edge_a", "edge_b"],
  "flow_events": [{ "event_type": "...", "payload": { "..." : "..." } }]
}
```

Execution context structure is always:
- `vars`: user-defined variables
- `system`: system variables (flow_id, trigger_type, etc)
- `context`: channel data (phone number, contact)
- `metadata`: request metadata

### Function node response

Return `vars` to update context:

```json
{
  "vars": { "processed": true, "result": "ok" }
}
```

### Decide node response

Return `next_edge` that matches an outgoing edge label:

```json
{
  "next_edge": "qualified",
  "vars": { "decision_reason": "qualified" }
}
```

Always fall back to the first available edge when unsure.

## Agent function tool payload

If an agent node uses a Function Tool, Kapso calls the function with:

```json
{
  "input": { "any": "shape" },
  "execution_context": { "vars": {}, "system": {}, "context": {}, "metadata": {} },
  "flow_events": [{ "event_type": "...", "payload": { "...": "..." } }],
  "flow_info": { "id": "uuid", "name": "...", "step_id": "uuid" },
  "whatsapp_context": { "conversation": { "...": "..." }, "messages": [] }
}
```

The tool expects a standard JSON response; you may return `vars` as above.

## WhatsApp Flow data endpoint payload

For WhatsApp Flow data endpoints, Kapso forwards:

```json
{
  "source": "whatsapp_flow",
  "flow": { "id": "<uuid>", "meta_flow_id": "<meta_id>" },
  "data_exchange": {
    "action": "INIT" | "data_exchange" | "BACK",
    "screen": "CURRENT_SCREEN_ID",
    "data": { "...": "..." },
    "flow_token": "opaque-token"
  },
  "signature_valid": true,
  "received_at": "2024-01-01T00:00:00Z"
}
```

Respond with:

```json
{
  "version": "3.0",
  "screen": "NEXT_SCREEN_ID",
  "data": {}
}
```

For full Flow JSON details and gotchas, load:
- `../integrate-whatsapp/references/whatsapp-flows-spec.md`

## Best practices

- Guard access: `const vars = body.execution_context?.vars || {};`
- Do not mutate `execution_context` in place; return new `vars`.
- Use try/catch for external API calls.
- Keep responses under the Meta timeout (10-15s).
