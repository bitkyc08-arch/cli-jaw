#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag, getNumberFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/list-executions.js <workflow-id> [--status <status>] [--waiting-reason <value>] [--whatsapp-conversation-id <id>] [--created-after <iso>] [--created-before <iso>] [--page <n>] [--per-page <n>]',
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

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'GET',
    path: `/platform/v1/workflows/${workflowId}/executions`,
    query: {
      status: getFlag(parsed.flags, 'status'),
      waiting_reason: getFlag(parsed.flags, 'waiting-reason'),
      whatsapp_conversation_id: getFlag(parsed.flags, 'whatsapp-conversation-id'),
      created_after: getFlag(parsed.flags, 'created-after'),
      created_before: getFlag(parsed.flags, 'created-before'),
      page: getNumberFlag(parsed.flags, 'page'),
      per_page: getNumberFlag(parsed.flags, 'per-page')
    }
  });

  if (!response.ok) {
    printJson(err('Failed to list executions', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ executions: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
