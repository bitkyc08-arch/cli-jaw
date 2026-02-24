#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/resume-execution.js <execution-id> --message <json> [--variables <json>]',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY'],
    examples: [
      'node scripts/resume-execution.js exec_123 --message \'{"data":{"text":"hi"}}\''
    ]
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

  const executionId = parsed.args[0] || getFlag(parsed.flags, 'execution-id');
  if (!executionId) {
    printJson(err('execution_id is required'));
    return 2;
  }

  let message;
  let variables;
  try {
    message = parseJson(getFlag(parsed.flags, 'message'), 'message');
    variables = parseJson(getFlag(parsed.flags, 'variables'), 'variables');
  } catch (error) {
    printJson(err('Failed to parse JSON', { message: error.message }));
    return 2;
  }

  if (!message || typeof message !== 'object') {
    printJson(err('message is required and must be a JSON object'));
    return 2;
  }

  const body = { message };
  if (variables) body.variables = variables;

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'POST',
    path: `/platform/v1/workflow_executions/${executionId}/resume`,
    body
  });

  if (!response.ok) {
    printJson(err('Failed to resume execution', response.raw, false, response.status));
    return 2;
  }

  printJson(ok({ execution: response.data }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
