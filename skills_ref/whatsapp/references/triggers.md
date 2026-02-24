# Workflow Triggers

Triggers are separate from the workflow graph. Do not store triggers in `workflow_graph`.

Trigger types:
- `inbound_message`: fires on WhatsApp message (requires `phone_number_id`).
- `api_call`: fires via Platform API.
- `whatsapp_event`: fires on WhatsApp events (requires `event`, optional `phone_number_id`).

Use these scripts:
- `scripts/list-triggers.js <workflow-id>`
- `scripts/create-trigger.js <workflow-id> --trigger-type <inbound_message|api_call|whatsapp_event> ...`
- `scripts/update-trigger.js --trigger-id <id> --active true|false`
- `scripts/delete-trigger.js --trigger-id <id>`
- `scripts/list-whatsapp-phone-numbers.js` (to find `phone_number_id`)

Notes:
- For inbound message triggers, use `phone_number_id` (Meta ID).
- For whatsapp_event triggers, use `event` like `whatsapp.message.delivered`.
- For API triggers, no extra fields are required.
