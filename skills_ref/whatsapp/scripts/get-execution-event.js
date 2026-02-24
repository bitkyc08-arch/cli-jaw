#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/get-execution-event.js <event-id> [--event-id <id>]',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const eventId = parsed.args[0] || getFlag(parsed.flags, 'event-id');
  if (!eventId) {
    printJson(err('event_id is required'));
    return 2;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'GET',
    path: `/platform/v1/workflow_events/${eventId}`
  });

  if (!response.ok && response.status === 404) {
    printJson(err('Execution event detail endpoint is not available in the Platform API.', {
      endpoint: '/platform/v1/workflow_events/:id'
    }, true, response.status));
    return 2;
  }

  if (!response.ok) {
    printJson(err('Failed to fetch execution event detail', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({
    event_id: eventId,
    event: response.data
  }));

  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
