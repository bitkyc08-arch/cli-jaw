#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/update-trigger.js --trigger-id <id> --active true|false',
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

  const active = parseBoolean(getFlag(parsed.flags, 'active'));
  if (active === undefined) {
    printJson(err('active is required (true or false)'));
    return 2;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'PATCH',
    path: `/platform/v1/triggers/${triggerId}`,
    body: { trigger: { active } }
  });

  if (!response.ok) {
    printJson(err('Failed to update trigger', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ trigger: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
