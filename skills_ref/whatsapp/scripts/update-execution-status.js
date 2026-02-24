#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/update-execution-status.js <execution-id> --status <ended|handoff|waiting>',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const executionId = parsed.args[0] || getFlag(parsed.flags, 'execution-id');
  if (!executionId) {
    printJson(err('execution_id is required'));
    return 2;
  }

  const status = getFlag(parsed.flags, 'status');
  if (!status) {
    printJson(err('status is required'));
    return 2;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'PATCH',
    path: `/platform/v1/workflow_executions/${executionId}`,
    body: { workflow_execution: { status } }
  });

  if (!response.ok) {
    printJson(err('Failed to update execution status', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ execution: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
