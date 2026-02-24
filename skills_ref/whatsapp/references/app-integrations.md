# App Integrations (Workflow Nodes and Agent Tools)

Use these when you need to call external apps (Slack, HubSpot, Sheets, etc).

## Step 1: Accounts

1. List connected accounts:
   - `scripts/list-accounts.js --app-slug <slug>`
   - Use `accounts[].pipedream_account_id` for any `--account-id` flag.
2. If no account exists, generate a connect link:
   - `scripts/create-connect-token.js --app-slug <slug>`
3. Ask the user to open the connect URL and finish OAuth, then re-run list-accounts.

## Action discovery notes

- `action_id` is the same as the action `key` returned by `search-actions`.
- Prefer one-word queries (ex: `calendar`, `slack`, `hubspot`) and then filter by `app_slug`.
- If a multi-word query returns nothing, retry with a single token.

## Inputs and variable_definitions (required for agent tools)

App integration tools only accept inputs defined by `variable_definitions`. These inputs are mapped into
`configured_props` using `{{placeholders}}`.

Rules:
- Every placeholder in `configured_props` becomes a required tool input.
- If `variable_definitions` is omitted, Kapso infers variable names from `{{placeholders}}`
  and treats them as `string`.
- Agent tool calls must pass an `input` object with these variables.

Example configured props:
```json
{
  "calendarId": "{{calendar_id}}",
  "timeMin": "{{time_min}}",
  "timeMax": "{{time_max}}"
}
```

Example variable definitions:
```json
{
  "calendar_id": "string",
  "time_min": "string",
  "time_max": "string"
}
```

Create integration with explicit variable definitions:
```bash
node scripts/create-integration.js \
  --action-id "google_calendar-query-free-busy-calendars" \
  --app-slug "google_calendar" \
  --account-id "<pipedream_account_id>" \
  --configured-props '{"calendarId":"{{calendar_id}}","timeMin":"{{time_min}}","timeMax":"{{time_max}}"}' \
  --variable-definitions '{"calendar_id":"string","time_min":"string","time_max":"string"}'
```

Example asset: `assets/agent-app-integration-example.json`

## Step 2: Choose integration path

### Option A: Pipedream node (workflow graph)

1. Search actions: `scripts/search-actions.js --query "slack" --app-slug slack`
2. Get schema: `scripts/get-action-schema.js --action-id <id>`
3. For remote options: `scripts/configure-prop.js --action-id <id> --prop-name <name> --account-id <pipedream_account_id>`
4. For dynamic props: `scripts/reload-props.js --action-id <id> --account-id <pipedream_account_id>`
5. Add a `pipedream` node to the graph with action_id, app_slug, account_id, configured_props.

### Option B: Agent app integration tool (preferred for agent nodes)

1. List existing integrations: `scripts/list-integrations.js`
2. If none, create one:
   - `scripts/create-integration.js --action-id <id> --app-slug <slug> --account-id <pipedream_account_id> --configured-props <json>`
3. Use the integration id in `flow_agent_app_integration_tools` on the agent node.

### Option C: Integration via webhook

Use only when calling from a webhook node or agent webhook tool.

1. Create integration (same as Option B).
2. Call:
   - `https://app.kapso.ai/api/v1/integrations/{integration_id}/invoke`

Rules:
- Prefer Option B for agent nodes.
- Pipedream URLs do not work in webhook nodes or agent webhook tools.
- Always get action_id from search-actions; do not guess.
