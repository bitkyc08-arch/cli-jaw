#!/usr/bin/env node
import fs from 'fs';
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/create-workflow.js --name <name> [--description <text>] [--definition-file <path> | --definition-json <json>]',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

function loadDefinition({ filePath, jsonText }) {
  if (filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }
  if (jsonText) {
    return JSON.parse(jsonText);
  }
  return undefined;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const name = getFlag(parsed.flags, 'name');
  if (!name) {
    printJson(err('name is required'));
    return 2;
  }

  const description = getFlag(parsed.flags, 'description');
  const definitionFile = getFlag(parsed.flags, 'definition-file');
  const definitionJson = getFlag(parsed.flags, 'definition-json');

  if (definitionFile && definitionJson) {
    printJson(err('Provide only one of --definition-file or --definition-json'));
    return 2;
  }

  let definition;
  try {
    definition = loadDefinition({ filePath: definitionFile, jsonText: definitionJson });
  } catch (error) {
    printJson(err('Failed to parse workflow definition JSON', { message: String(error?.message || error) }));
    return 2;
  }

  const payload = {
    workflow: {
      name,
      description
    }
  };

  if (definition) {
    payload.workflow.definition = definition;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'POST',
    path: '/platform/v1/workflows',
    body: payload
  });

  if (!response.ok) {
    printJson(err('Failed to create workflow', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ workflow: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
