#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/get-context-value.js <execution-id> --variable-path <path>',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY'],
    examples: ['node scripts/get-context-value.js exec_123 --variable-path vars.user_name']
  });
}

function getPathValue(obj, path) {
  if (!path) return undefined;
  const parts = path.split('.').filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
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

  const variablePath = getFlag(parsed.flags, 'variable-path');
  if (!variablePath) {
    printJson(err('variable-path is required'));
    return 2;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'GET',
    path: `/platform/v1/workflow_executions/${executionId}`
  });

  if (!response.ok) {
    printJson(err('Failed to fetch execution', response.raw, false, response.status));
    return 2;
  }

  const execution = response.data;
  const executionContext = execution && execution.execution_context ? execution.execution_context : {};
  let path = variablePath;

  if (path.startsWith('execution_context.')) {
    path = path.replace(/^execution_context\./, '');
  }

  const value = getPathValue(executionContext, path);

  if (value === undefined) {
    printJson(err('Path not found in execution_context', { variable_path: variablePath }));
    return 2;
  }

  printJson(ok({ value, variable_path: variablePath, execution_id: executionId }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
