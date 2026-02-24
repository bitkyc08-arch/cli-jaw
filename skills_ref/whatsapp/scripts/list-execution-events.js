#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag, getNumberFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage:
      'node scripts/list-execution-events.js <execution-id> [--event-type <type>] [--page <n>] [--per-page <n>]',
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

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'GET',
    path: `/platform/v1/workflow_executions/${executionId}/events`,
    query: {
      event_type: getFlag(parsed.flags, 'event-type'),
      page: getNumberFlag(parsed.flags, 'page') ?? getNumberFlag(parsed.flags, 'offset'),
      per_page: getNumberFlag(parsed.flags, 'per-page') ?? getNumberFlag(parsed.flags, 'limit')
    }
  });

  if (!response.ok && response.status === 404) {
    printJson(err('Execution events endpoint is not available in the Platform API.', {
      endpoint: '/platform/v1/workflow_executions/:id/events'
    }, true, response.status));
    return 2;
  }

  if (!response.ok) {
    printJson(err('Failed to fetch execution events', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({
    execution_id: executionId,
    events: response.data
  }));

  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
