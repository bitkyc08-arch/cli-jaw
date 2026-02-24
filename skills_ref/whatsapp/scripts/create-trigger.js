#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/create-trigger.js <workflow-id> --trigger-type <inbound_message|api_call|whatsapp_event> [--phone-number-id <id>] [--event <whatsapp.event>] [--active true|false] [--triggerable-attributes <json>]',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (value === true) return true;
  const lowered = String(value).toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  return undefined;
}

function parseJson(value) {
  if (!value) return undefined;
  return JSON.parse(value);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const workflowId = parsed.args[0] || getFlag(parsed.flags, 'workflow-id');
  if (!workflowId) {
    printJson(err('workflow_id is required'));
    return 2;
  }

  const triggerType = getFlag(parsed.flags, 'trigger-type');
  if (!triggerType) {
    printJson(err('trigger-type is required'));
    return 2;
  }

  const active = parseBoolean(getFlag(parsed.flags, 'active'));
  const phoneNumberId = getFlag(parsed.flags, 'phone-number-id');
  const whatsappConfigId = getFlag(parsed.flags, 'whatsapp-config-id');
  const event = getFlag(parsed.flags, 'event');

  let triggerableAttributes;
  try {
    triggerableAttributes = parseJson(getFlag(parsed.flags, 'triggerable-attributes'));
  } catch (error) {
    printJson(err('Invalid JSON for triggerable-attributes', { message: String(error?.message || error) }));
    return 2;
  }

  const triggerPayload = {
    trigger_type: triggerType
  };

  if (active !== undefined) triggerPayload.active = active;
  if (phoneNumberId) triggerPayload.phone_number_id = phoneNumberId;
  if (whatsappConfigId) triggerPayload.whatsapp_config_id = whatsappConfigId;
  if (event) triggerPayload.event = event;
  if (triggerableAttributes) triggerPayload.triggerable_attributes = triggerableAttributes;

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'POST',
    path: `/platform/v1/workflows/${workflowId}/triggers`,
    body: { trigger: triggerPayload }
  });

  if (!response.ok) {
    printJson(err('Failed to create trigger', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ trigger: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
