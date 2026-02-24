# Payload Shapes (Quick Reference)

## Workflow function node (request)

Kapso sends:

```json
{
  "execution_context": {
    "vars": { "user_name": "John", "score": 42 },
    "system": { "flow_id": "uuid", "flow_name": "...", "trigger_type": "inbound_message" },
    "context": { "channel": "whatsapp", "phone_number": "+1234567890", "contact": { "wa_id": "...", "profile_name": "..." } },
    "metadata": { "request": { "ip": "...", "timestamp": "..." } }
  },
  "available_edges": ["edge_a", "edge_b"],
  "flow_events": [{ "event_type": "...", "payload": { "...": "..." } }]
}
```

### Function node response

Return vars to merge:

```json
{ "vars": { "processed": true, "result": "ok" } }
```

## Workflow decide node (request)

Same request shape as function nodes.

### Decide node response

Return `next_edge` that matches an outgoing edge label:

```json
{ "next_edge": "qualified", "vars": { "decision_reason": "qualified" } }
```

Always fall back to the first available edge if unsure.

## Agent function tool (request)

```json
{
  "input": { "any": "shape" },
  "execution_context": { "vars": {}, "system": {}, "context": {}, "metadata": {} },
  "flow_events": [{ "event_type": "...", "payload": { "...": "..." } }],
  "flow_info": { "id": "uuid", "name": "...", "step_id": "uuid" },
  "whatsapp_context": { "conversation": { "...": "..." }, "messages": [] }
}
```

## WhatsApp Flow data endpoint (request)

Kapso forwards:

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

### WhatsApp Flow response

```json
{
  "version": "3.0",
  "screen": "NEXT_SCREEN_ID",
  "data": {}
}
```

## Code rules

- Code MUST start with: `async function handler(request, env) {`
- Do NOT use `export`, `export default`, or arrow functions.
- Output only JavaScript source code (no markdown fences).
