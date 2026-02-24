#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/search-actions.js --query <text> [--app-slug <slug>]',
    notes: [
      'Prefer one-word queries (ex: "calendar", "slack", "hubspot").',
      'Use --app-slug to narrow results to a single app.',
      'action_id equals the action key returned in results.'
    ],
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const query = getFlag(parsed.flags, 'query');
  if (!query) {
    printJson(err('query is required'));
    return 2;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'GET',
    path: '/platform/v1/integrations/actions',
    query: {
      query,
      app_slug: getFlag(parsed.flags, 'app-slug')
    }
  });

  if (!response.ok) {
    printJson(err('Failed to search actions', response.raw, false, response.status));
    return 2;
  }

  const raw = response.data;
  const actions = Array.isArray(raw?.actions) ? raw.actions : (Array.isArray(raw) ? raw : []);
  const mapped = actions.map((action) => ({
    ...action,
    action_id: action.action_id || action.key
  }));
  const payload = Array.isArray(raw) ? mapped : { ...raw, actions: mapped };

  printJson(ok({
    actions: payload,
    note: 'Use action_id (same as key) with get-action-schema/create-integration.'
  }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
