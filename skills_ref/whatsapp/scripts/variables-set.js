#!/usr/bin/env node
import { loadConfig } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/variables-set.js <workflow-id> --name <name> --value <value>',
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
  const name = getFlag(parsed.flags, 'name');
  const value = getFlag(parsed.flags, 'value');

  const config = loadConfig();

  printJson(err('Workflow variables create/update is not available in the Platform API.', {
    workflow_id: workflowId,
    name,
    value,
    note: 'Only variable discovery is proposed; CRUD endpoints are missing.'
  }, true));

  return 2;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
