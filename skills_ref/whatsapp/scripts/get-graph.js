#!/usr/bin/env node
import { createHash } from 'crypto';
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function addLineNumbers(text) {
  return text
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function usage() {
  return ok({
    usage: 'node scripts/get-graph.js <workflow-id> [--workflow-id <id>]',
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
  if (!workflowId) {
    printJson(err('workflow_id is required'));
    return 2;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'GET',
    path: `/platform/v1/workflows/${workflowId}/definition`
  });

  if (!response.ok) {
    printJson(err('Failed to fetch workflow definition', response.raw, false, response.status));
    return 2;
  }

  const workflow = response.data;
  const definition = workflow && typeof workflow === 'object' ? workflow.definition : null;
  if (!definition || typeof definition !== 'object') {
    printJson(err('Workflow definition missing in response', response.raw, false, response.status));
    return 2;
  }

  const pretty = JSON.stringify(definition, null, 2);
  const hash = sha256(pretty);
  const withLines = addLineNumbers(pretty);

  const trimmedWorkflow = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    lock_version: workflow.lock_version,
    message_debounce_seconds: workflow.message_debounce_seconds,
    project_id: workflow.project_id,
    updated_at: workflow.updated_at
  };

  printJson(ok({
    workflow: trimmedWorkflow,
    definition,
    workflow_graph_pretty: pretty,
    workflow_graph_with_lines: withLines,
    workflow_graph_sha256: hash
  }));

  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
