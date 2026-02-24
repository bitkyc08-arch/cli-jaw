# Workflow Graph Contract (Workflows / Definition)

This document is the source of truth for editing Kapso workflow graphs over the Platform API.

## Endpoints and envelopes

- Fetch graph (definition): `GET /platform/v1/workflows/:id/definition`
  - Returns a workflow record that includes `definition` (nodes + edges).
- Fetch metadata: `GET /platform/v1/workflows/:id`
  - Returns workflow metadata (including `lock_version`) but does NOT include `definition`.
- Update graph/settings: `PATCH /platform/v1/workflows/:id`
  - Send `workflow: { ... }` (what the scripts use). `flow: { ... }` is accepted as an alias.
  - To update the graph, send `workflow: { definition: <definition> }`.

## Two graph shapes: returned vs editable

### Shape returned by get-graph (ReactFlow-style)

`GET /workflows/:id/definition` returns a ReactFlow-style definition that includes extra/computed fields:

```json
{
  "nodes": [
    {
      "id": "start",
      "type": "flow-node",
      "position": { "x": 120, "y": 120 },
      "data": { "node_type": "start", "config": {}, "display_name": "Start" }
    }
  ],
  "edges": [
    {
      "id": "uuid",
      "source": "start",
      "target": "send_text_1710000000000",
      "label": "next",
      "type": "default",
      "flow_condition_id": null
    }
  ]
}
```

### Minimal editable shape accepted by the API

For `PATCH /workflows/:id`, the minimal shape you should edit and send is:

```json
{
  "nodes": [
    {
      "id": "start",
      "position": { "x": 120, "y": 120 },
      "data": { "node_type": "start", "config": {} }
    },
    {
      "id": "send_text_1710000000000",
      "position": { "x": 120, "y": 320 },
      "data": {
        "node_type": "send_text",
        "config": { "message": "Hello!", "delay_seconds": 0 }
      }
    }
  ],
  "edges": [
    { "source": "start", "target": "send_text_1710000000000", "label": "next" }
  ]
}
```

The API ignores/strips extra fields like `node.type`, `data.display_name`, `edge.id`, and `edge.type`. You can keep them unchanged when roundtripping, but do not rely on editing them.

## Nodes

Required:
- `node.id` (string)
- `node.position.x`, `node.position.y` (numbers)
- `node.data.node_type` (string)
- `node.data.config` (object; per node_type)

Rules:
- Exactly one start node with `id = "start"` and `data.node_type = "start"`.
- Never change existing node IDs.
- For new nodes: use `{node_type}_{timestamp_ms}` for the `id`.

Footgun (important):
- If `data.node_type` is missing, the backend defaults it to `"start"`.
- If you create a node with an unknown `data.node_type`, the backend will create it as a start-like step.
- Always validate before updating: `node scripts/validate-graph.js --definition-file <path>` and treat warnings as blockers.

## Edges

Required:
- `edge.source` (existing node id)
- `edge.target` (existing node id)
- `edge.label` (string)

Rules:
- Non-decide nodes: 0 or 1 outgoing edge; if present, its `label` must be `"next"`.
- Decide nodes: one outgoing edge per condition; each edge `label` must match `config.conditions[].label`.

Optional:
- `edge.flow_condition_id` (only meaningful for decide edges). If present, it must refer to a condition on that decide node.

## Decide node conditions (ids)

For `decide` nodes, `config.conditions[]` controls valid outgoing edge labels.

- When creating NEW conditions, do not include an `id` field (the backend generates it).
- When editing an EXISTING decide node fetched from the API, you may see `conditions[].id` and `edges[].flow_condition_id` in the returned graph. Keep them unchanged unless you have a specific reason to remove/rebuild the decide node.

## Computed vs editable fields

Do edit:
- `node.position`
- `node.data.node_type`
- `node.data.config`
- `edge.source`, `edge.target`, `edge.label`

Do NOT treat as editable (computed/ignored/unstable):
- `node.data.display_name`
- `edge.id`, `edge.type`
- any `*_name` fields (model names, function names, etc.)

## Terminal nodes and agent nodes

- Terminal nodes (leaf nodes) are allowed. A node with no outgoing edge ends the workflow after that step completes.
- Agent nodes can be terminal or can continue via a `"next"` edge, depending on what you want:
  - Terminal agent: the agent handles the conversation and finishes via its tools (ex: complete_task or handoff_to_human).
  - Continuing agent: add a `"next"` edge if you want deterministic post-agent steps (ex: send_text summary).

## lock_version conflicts (exact retry pattern)

The Platform API does not currently enforce `lock_version` for definition updates, so the scripts do a precheck.

Use this pattern:
1. Fetch graph and lock_version: `node scripts/get-graph.js <workflow_id>`
2. Apply change with lock precheck:
   - Small surgical edit: `node scripts/edit-graph.js <workflow_id> --expected-lock-version <n> ...`
   - Full update: `node scripts/update-graph.js <workflow_id> --expected-lock-version <n> --definition-file <path>`
     - `update-graph.js` can extract `definition` from wrapper JSON, but prefer sending just the `definition` object.
3. If you get a conflict error:
   - Re-fetch the latest graph to get the new lock_version.
   - Re-apply your change on top of the latest definition.
   - Retry with the new expected lock version.
