#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/list-provider-models.js',
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
    path: '/platform/v1/provider_models'
  });

  if (!response.ok && response.status === 404) {
    printJson(err('Provider models endpoint is not available in the Platform API.', {
      endpoint: '/platform/v1/provider_models'
    }, true, response.status));
    return 2;
  }

  if (!response.ok) {
    printJson(err('Failed to fetch provider models', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({
    provider_models: response.data
  }));

  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
