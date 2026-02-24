#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/list-accounts.js [--app-slug <slug>]',
    notes: [
      'Use accounts[].pipedream_account_id for any --account-id flag.',
      'The internal accounts[].id will not work for integrations.'
    ],
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

function normalizeAccounts(payload) {
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.accounts?.accounts)) return payload.accounts.accounts;
  if (Array.isArray(payload)) return payload;
  return [];
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
    path: '/platform/v1/integrations/accounts',
    query: {
      app_slug: getFlag(parsed.flags, 'app-slug')
    }
  });

  if (!response.ok) {
    printJson(err('Failed to list accounts', response.raw, false, response.status));
    return 2;
  }

  const raw = response.data;
  const accounts = normalizeAccounts(raw).map((account) => ({
    ...account,
    preferred_account_id: account.pipedream_account_id
  }));
  const payload = Array.isArray(raw) ? accounts : { ...raw, accounts };

  printJson(ok({
    accounts: payload,
    note: 'Use preferred_account_id (pipedream_account_id) for create-integration/configure-prop.'
  }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
