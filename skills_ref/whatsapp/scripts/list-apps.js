#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag, getNumberFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/list-apps.js [--query <text>] [--limit <n>]',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'GET',
    path: '/platform/v1/integrations/apps',
    query: {
      query: getFlag(parsed.flags, 'query'),
      limit: getNumberFlag(parsed.flags, 'limit')
    }
  });

  if (!response.ok) {
    printJson(err('Failed to list apps', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ apps: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
