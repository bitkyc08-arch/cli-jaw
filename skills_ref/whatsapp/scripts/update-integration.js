#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/update-integration.js --integration-id <id> [--configured-props <json>] [--name <text>] [--variable-definitions <json>] [--dynamic-props-id <id>]',
    notes: [
      'Use --variable-definitions to update required tool input fields.'
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

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const integrationId = getFlag(parsed.flags, 'integration-id');
  if (!integrationId) {
    printJson(err('integration-id is required'));
    return 2;
  }

  let configuredProps;
  let variableDefinitions;

  try {
    configuredProps = parseJson(getFlag(parsed.flags, 'configured-props'), 'configured-props');
    variableDefinitions = parseJson(getFlag(parsed.flags, 'variable-definitions'), 'variable-definitions');
  } catch (error) {
    printJson(err('Failed to parse JSON', { message: error.message }));
    return 2;
  }

  const payload = {};
  const name = getFlag(parsed.flags, 'name');
  const dynamicPropsId = getFlag(parsed.flags, 'dynamic-props-id');

  if (name) payload.name = name;
  if (dynamicPropsId) payload.dynamic_props_id = dynamicPropsId;
  if (configuredProps) payload.configured_props = configuredProps;
  if (variableDefinitions) payload.variable_definitions = variableDefinitions;

  if (!Object.keys(payload).length) {
    printJson(err('No updates provided'));
    return 2;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'PATCH',
    path: `/platform/v1/integrations/${integrationId}`,
    body: payload
  });

  if (!response.ok) {
    printJson(err('Failed to update integration', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ integration: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
