# Reference

## Overview

This skill manages workflow graphs, triggers, executions, and app integrations over the Platform API and provides local graph validation. Variables CRUD is not supported and will return blocked responses.

## Environment

Required env vars:

- `KAPSO_API_BASE_URL` (host only, no `/platform/v1`, example: `https://api.kapso.ai`)
- `KAPSO_API_KEY`

## Scripts

Each script is a single operation. Run with `node` or `bun`.

- `scripts/get-graph.js`
- `scripts/list-workflows.js`
- `scripts/get-workflow.js`
- `scripts/create-workflow.js`
- `scripts/update-workflow-settings.js`
- `scripts/edit-graph.js`
- `scripts/update-graph.js`
- `scripts/validate-graph.js`
- `scripts/list-triggers.js`
- `scripts/create-trigger.js`
- `scripts/update-trigger.js`
- `scripts/delete-trigger.js`
- `scripts/list-executions.js`
- `scripts/get-execution.js`
- `scripts/get-context-value.js`
- `scripts/update-execution-status.js`
- `scripts/resume-execution.js`
- `scripts/variables-list.js`
- `scripts/variables-set.js` (blocked)
- `scripts/variables-delete.js` (blocked)
- `scripts/list-provider-models.js`
- `scripts/list-execution-events.js`
- `scripts/get-execution-event.js`
- `scripts/list-apps.js`
- `scripts/search-actions.js`
- `scripts/get-action-schema.js`
- `scripts/list-accounts.js`
- `scripts/create-connect-token.js`
- `scripts/configure-prop.js`
- `scripts/reload-props.js`
- `scripts/list-integrations.js`
- `scripts/create-integration.js`
- `scripts/update-integration.js`
- `scripts/delete-integration.js`
- `scripts/list-whatsapp-phone-numbers.js`

## Platform API endpoints

Implemented calls:

- `GET /platform/v1/workflows`
- `POST /platform/v1/workflows`
- `GET /platform/v1/workflows/:id`
- `GET /platform/v1/workflows/:id/definition` (fetch graph definition)
- `PATCH /platform/v1/workflows/:id` (update settings/definition)
- `GET /platform/v1/workflows/:id/variables` (workflow variable discovery)
- `GET /platform/v1/workflows/:workflow_id/triggers`
- `POST /platform/v1/workflows/:workflow_id/triggers`
- `PATCH /platform/v1/triggers/:id`
- `DELETE /platform/v1/triggers/:id`
- `GET /platform/v1/workflows/:workflow_id/executions`
- `GET /platform/v1/workflow_executions/:id`
- `PATCH /platform/v1/workflow_executions/:id`
- `POST /platform/v1/workflow_executions/:id/resume`
- `GET /platform/v1/workflow_executions/:id/events`
- `GET /platform/v1/workflow_events/:id`
- `GET /platform/v1/provider_models`
- `GET /platform/v1/integrations`
- `POST /platform/v1/integrations`
- `PATCH /platform/v1/integrations/:id`
- `DELETE /platform/v1/integrations/:id`
- `GET /platform/v1/integrations/apps`
- `GET /platform/v1/integrations/actions`
- `GET /platform/v1/integrations/accounts`
- `POST /platform/v1/integrations/connect_token`
- `GET /platform/v1/integrations/actions/:action_id/schema`
- `POST /platform/v1/integrations/actions/:action_id/configure_prop`
- `POST /platform/v1/integrations/actions/:action_id/reload_props`
- `GET /platform/v1/whatsapp/phone_numbers` (for inbound_message triggers)

Variables CRUD endpoints are not defined for Platform API. Scripts intentionally return blocked for create/update/delete operations.

## Workflow graphs: endpoints, shapes, and roundtrips

- `GET /platform/v1/workflows/:id` returns workflow metadata (including `lock_version`) but does NOT include `definition`.
- `GET /platform/v1/workflows/:id/definition` returns a workflow record that includes `definition` (nodes + edges).
- `PATCH /platform/v1/workflows/:id` accepts either `workflow: { ... }` or `flow: { ... }` envelopes.
  - To update the graph: send `workflow: { definition: <definition> }`.

Graph shapes:
- `get-graph.js` returns a ReactFlow-style definition that includes extra/computed fields (`node.type`, `data.display_name`, `edge.id`, `edge.type`).
- The API accepts a minimal editable definition (`nodes[].id/position/data.node_type/data.config` and `edges[].source/target/label`) and ignores/strips extra fields.

Source of truth: `references/graph-contract.md`.

## Phone number lookup for triggers

Use `scripts/list-whatsapp-phone-numbers.js` to find `phone_number_id` for inbound_message triggers.
Do not use `/whatsapp_configs` (not a Platform API endpoint).

## Graph validation rules (local)

The `scripts/validate-graph.js` script checks:

- Exactly one start node with `id` = `start` and `data.node_type` = `start`.
- Unique node IDs and valid edge source/target IDs.
- Non-empty edge labels.
- Only `decide` nodes may branch; other nodes may have 0 or 1 outgoing `next` edge.
- Decide node condition labels must match outgoing edge labels.

Warnings are emitted for unknown node types or extra decide edges. Treat warnings as blockers before you PATCH a graph.

## Assets

- `assets/workflow-linear.json` (simple linear example)
- `assets/workflow-decision.json` (wait + decide example)
