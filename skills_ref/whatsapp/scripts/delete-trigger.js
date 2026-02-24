#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/delete-trigger.js --trigger-id <id>',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const triggerId = getFlag(parsed.flags, 'trigger-id');
  if (!triggerId) {
    printJson(err('trigger-id is required'));
    return 2;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'DELETE',
    path: `/platform/v1/triggers/${triggerId}`
  });

  if (!response.ok) {
    printJson(err('Failed to delete trigger', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ deleted: true, status: response.status }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
