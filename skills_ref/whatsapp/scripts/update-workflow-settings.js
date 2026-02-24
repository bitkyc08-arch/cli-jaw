#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag, getNumberFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/update-workflow-settings.js <workflow-id> --lock-version <n> [--name <name>] [--description <text>] [--status <draft|active|archived>] [--message-debounce-seconds <n>]',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
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

  const lockVersion = getNumberFlag(parsed.flags, 'lock-version');
  if (lockVersion === undefined) {
    printJson(err('lock-version is required'));
    return 2;
  }

  const payload = {
    workflow: {
      lock_version: lockVersion
    }
  };

  const name = getFlag(parsed.flags, 'name');
  const description = getFlag(parsed.flags, 'description');
  const status = getFlag(parsed.flags, 'status');
  const messageDebounce = getNumberFlag(parsed.flags, 'message-debounce-seconds');

  if (name) payload.workflow.name = name;
  if (description) payload.workflow.description = description;
  if (status) payload.workflow.status = status;
  if (messageDebounce !== undefined) payload.workflow.message_debounce_seconds = messageDebounce;

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'PATCH',
    path: `/platform/v1/workflows/${workflowId}`,
    body: payload
  });

  if (!response.ok) {
    printJson(err('Failed to update workflow', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ workflow: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
