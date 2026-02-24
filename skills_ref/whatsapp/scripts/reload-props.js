#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/reload-props.js --action-id <id> --account-id <id> [--configured-props <json>] [--dynamic-props-id <id>]',
    notes: [
      'Use accounts[].pipedream_account_id for --account-id.',
      'If you pass an internal account UUID, the script will try to resolve it.'
    ],
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

function parseJson(value, label) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${label}: ${String(error?.message || error)}`);
  }
}

function normalizeAccounts(payload) {
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.accounts?.accounts)) return payload.accounts.accounts;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function resolveAccountId(config, accountId) {
  if (accountId.startsWith('apn_')) return accountId;

  const response = await requestJson(config, {
    method: 'GET',
    path: '/platform/v1/integrations/accounts'
  });

  if (!response.ok) {
    throw new Error('Unable to resolve account id. Use list-accounts and pass pipedream_account_id.');
  }

  const accounts = normalizeAccounts(response.data);
  const match = accounts.find((account) => account.id === accountId);
  if (match?.pipedream_account_id) return match.pipedream_account_id;

  throw new Error('account-id must be pipedream_account_id (use list-accounts output).');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const actionId = getFlag(parsed.flags, 'action-id');
  const accountId = getFlag(parsed.flags, 'account-id');
  if (!actionId || !accountId) {
    printJson(err('action-id and account-id are required'));
    return 2;
  }

  let configuredProps = {};
  try {
    const provided = parseJson(getFlag(parsed.flags, 'configured-props'), 'configured-props');
    configuredProps = provided || {};
  } catch (error) {
    printJson(err('Failed to parse configured-props', { message: error.message }));
    return 2;
  }

  const config = loadConfig();
  let resolvedAccountId = accountId;

  try {
    resolvedAccountId = await resolveAccountId(config, accountId);
  } catch (error) {
    printJson(err('Failed to resolve account-id', { message: error.message }));
    return 2;
  }

  if (!Object.keys(configuredProps).length) {
    configuredProps = { account_id: resolvedAccountId };
  }

  const response = await requestJson(config, {
    method: 'POST',
    path: `/platform/v1/integrations/actions/${actionId}/reload_props`,
    body: {
      configured_props: configuredProps,
      dynamic_props_id: getFlag(parsed.flags, 'dynamic-props-id')
    }
  });

  if (!response.ok) {
    printJson(err('Failed to reload props', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ result: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
