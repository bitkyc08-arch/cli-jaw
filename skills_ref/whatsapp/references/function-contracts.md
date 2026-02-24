# Workflow Function Contracts

Use this when configuring function or decide nodes.

## Code rules (must follow)

- Code MUST start with: `async function handler(request, env) {`
- Do NOT use `export`, `export default`, or arrow functions.
- Output only JavaScript source code (no markdown fences).

## Payload (function/decide nodes)

```json
{
  "execution_context": { "vars": {}, "system": {}, "context": {}, "metadata": {} },
  "available_edges": ["edge_a", "edge_b"],
  "flow_events": [{ "event_type": "...", "payload": {} }]
}
```

## Function node response

Return variables to merge:

```json
{ "vars": { "processed": true } }
```

## Decide node response

Return `next_edge` matching an outgoing edge label:

```json
{ "next_edge": "qualified", "vars": { "decision_reason": "qualified" } }
```

Always fall back to the first available edge if unsure.

## Agent Function Tool

Agent node function tools receive:

```json
{
  "input": { "any": "shape" },
  "execution_context": { "vars": {}, "system": {}, "context": {}, "metadata": {} },
  "flow_events": [],
  "flow_info": { "id": "uuid", "name": "...", "step_id": "uuid" },
  "whatsapp_context": { "conversation": {}, "messages": [] }
}
```

For full runtime contract details, load:
- `functions-reference.md`
- `functions-payloads.md`
