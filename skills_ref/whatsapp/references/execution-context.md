# Execution Context and Variables

Execution context shape:

```json
{
  "vars": { "user_name": "Alice" },
  "system": { "flow_id": "uuid", "flow_name": "...", "trigger_type": "inbound_message" },
  "context": { "channel": "whatsapp", "phone_number": "+1234567890", "contact": { "wa_id": "...", "profile_name": "..." } },
  "metadata": { "request": { "ip": "...", "timestamp": "..." } }
}
```

Always use this structure:
- `vars`: user-defined variables
- `system`: system variables (flow_id, trigger_type, etc)
- `context`: channel info (phone number, contact)
- `metadata`: request metadata

## Variable syntax

Environment variables (secrets):
- `${ENV:VARIABLE_NAME}`

Runtime variables:
- `{{vars.my_variable}}`
- `{{system.flow_name}}`
- `{{context.phone_number}}`

Substitution order:
1. Environment variables
2. Runtime variables

Important WhatsApp keys:
- `{{system.whatsapp_config.phone_number_id}}` (Meta phone_number_id)
- `{{system.trigger_whatsapp_config_id}}` (Kapso WhatsApp config id)
- `{{context.phone_number}}` (recipient phone)

Never guess variable paths. Use:
- `scripts/variables-list.js <workflow-id>`
- `scripts/get-execution.js <execution-id>`
- `scripts/get-context-value.js <execution-id> --variable-path <path>`
