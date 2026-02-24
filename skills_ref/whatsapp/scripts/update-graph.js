#!/usr/bin/env node
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag, getNumberFlag } from './lib/workflows/args.js';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readFileText(path) {
  return readFileSync(path, 'utf8');
}

function normalizeDefinition(input) {
  if (!input || typeof input !== 'object') return null;
  const record = input;

  if (record.ok === true && record.data && typeof record.data === 'object') {
    return normalizeDefinition(record.data);
  }

  if (record.definition && typeof record.definition === 'object') {
    return record.definition;
  }

  if (record.flow && typeof record.flow === 'object') {
    const flow = record.flow;
    if (flow.definition && typeof flow.definition === 'object') {
      return flow.definition;
    }
  }

  if (record.workflow && typeof record.workflow === 'object') {
    const workflow = record.workflow;
    if (workflow.definition && typeof workflow.definition === 'object') {
      return workflow.definition;
    }
  }

  if (record.nodes && record.edges) {
    return record;
  }

  return null;
}

function parseDefinitionInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    return normalizeDefinition(parsed);
  } catch {
    return null;
  }
}

function usage() {
  return ok({
    usage: 'node scripts/update-graph.js <workflow-id> --expected-lock-version <n> --definition-file <path>|--definition-json <json>',
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

  const expectedLockVersion = getNumberFlag(parsed.flags, 'expected-lock-version')
    ?? getNumberFlag(parsed.flags, 'lock-version');
  if (expectedLockVersion === undefined) {
    printJson(err('expected-lock-version is required'));
    return 2;
  }

  const definitionFile = getFlag(parsed.flags, 'definition-file');
  const definitionJson = getFlag(parsed.flags, 'definition-json');
  if (!definitionFile && !definitionJson) {
    printJson(err('definition-file or definition-json is required'));
    return 2;
  }

  const rawDefinition = definitionFile ? readFileText(definitionFile) : definitionJson || '';
  const definition = parseDefinitionInput(rawDefinition);
  if (!definition) {
    const source = definitionFile ? 'definition-file' : 'definition-json';
    printJson(err(`Unable to parse workflow definition from ${source}`));
    return 2;
  }

  const config = loadConfig();
  const current = await requestJson(config, {
    method: 'GET',
    path: `/platform/v1/workflows/${workflowId}`
  });

  if (!current.ok) {
    printJson(err('Failed to fetch workflow metadata for lock check', current.raw, false, current.status));
    return 2;
  }

  const currentLock = current.data.lock_version;
  if (currentLock !== expectedLockVersion) {
    printJson(err('Conflict: workflow was modified. Refetch and retry.', {
      expected_lock_version: expectedLockVersion,
      current_lock_version: currentLock
    }));
    return 2;
  }

  const update = await requestJson(config, {
    method: 'PATCH',
    path: `/platform/v1/workflows/${workflowId}`,
    body: {
      workflow: {
        definition
      }
    }
  });

  if (!update.ok) {
    printJson(err('Failed to update workflow definition', update.raw, false, update.status));
    return 2;
  }

  const pretty = JSON.stringify(definition, null, 2);

  printJson(ok({
    workflow: {
      id: update.data.id,
      name: update.data.name,
      status: update.data.status,
      lock_version: update.data.lock_version,
      updated_at: update.data.updated_at
    },
    workflow_graph_sha256: sha256(pretty)
  }));

  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
