#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/variables-list.js <workflow-id> [--workflow-id <id>]',
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
    path: `/platform/v1/workflows/${workflowId}/variables`
  });

  if (!response.ok && response.status === 404) {
    printJson(err('Workflow variables endpoint is not available in the Platform API.', {
      endpoint: '/platform/v1/workflows/:id/variables'
    }, true, response.status));
    return 2;
  }

  if (!response.ok) {
    printJson(err('Failed to fetch workflow variables', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({
    workflow_id: workflowId,
    variables: response.data
  }));

  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
