#!/usr/bin/env node
import { readFileSync } from 'fs';
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag } from './lib/workflows/args.js';

const SUPPORTED_NODE_TYPES = new Set([
  'start',
  'send_text',
  'send_template',
  'set_variable',
  'send_interactive',
  'wait_for_response',
  'decide',
  'call',
  'webhook',
  'pipedream',
  'function',
  'agent',
  'handoff'
]);

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

function validateDefinition(definition) {
  const errors = [];
  const warnings = [];

  const nodes = Array.isArray(definition.nodes) ? definition.nodes : null;
  const edges = Array.isArray(definition.edges) ? definition.edges : null;

  if (!nodes) {
    errors.push('definition.nodes must be an array');
  }
  if (!edges) {
    errors.push('definition.edges must be an array');
  }

  if (!nodes || !edges) {
    return { errors, warnings, stats: { nodes: 0, edges: 0, decideNodes: 0 } };
  }

  const nodeIds = new Set();
  const nodeTypes = {};
  const outgoingEdges = {};

  nodes.forEach((node, index) => {
    if (!node || typeof node !== 'object') {
      errors.push(`node[${index}] must be an object`);
      return;
    }

    const nodeId = node.id;
    if (typeof nodeId !== 'string' || nodeId.trim() === '') {
      errors.push(`node[${index}].id must be a non-empty string`);
      return;
    }

    if (nodeIds.has(nodeId)) {
      errors.push(`duplicate node id: ${nodeId}`);
      return;
    }

    nodeIds.add(nodeId);

    const data = node.data || {};
    const nodeType = data.node_type;
    if (!nodeType) {
      errors.push(`node ${nodeId} is missing data.node_type`);
    } else {
      nodeTypes[nodeId] = nodeType;
      if (!SUPPORTED_NODE_TYPES.has(nodeType)) {
        warnings.push(`node ${nodeId} has unknown node_type: ${nodeType}`);
      }
    }
  });

  const startNodes = [...nodeIds].filter((id) => id === 'start');
  if (startNodes.length !== 1) {
    errors.push('graph must contain exactly one start node with id "start"');
  } else if (nodeTypes.start && nodeTypes.start !== 'start') {
    errors.push('start node must have data.node_type = "start"');
  }

  edges.forEach((edge, index) => {
    if (!edge || typeof edge !== 'object') {
      errors.push(`edge[${index}] must be an object`);
      return;
    }

    const source = edge.source;
    const target = edge.target;
    const label = edge.label;

    if (typeof source !== 'string' || !nodeIds.has(source)) {
      errors.push(`edge[${index}] has invalid source: ${String(source)}`);
    }
    if (typeof target !== 'string' || !nodeIds.has(target)) {
      errors.push(`edge[${index}] has invalid target: ${String(target)}`);
    }
    if (typeof label !== 'string' || label.trim() === '') {
      errors.push(`edge[${index}] must have a non-empty label`);
    }

    if (typeof source === 'string') {
      outgoingEdges[source] = outgoingEdges[source] || [];
      if (typeof label === 'string') {
        outgoingEdges[source].push(label);
      }
    }
  });

  let decideNodes = 0;
  nodes.forEach((node) => {
    if (!node || typeof node !== 'object') return;
    const nodeId = node.id;
    const nodeType = nodeTypes[nodeId];
    const outgoing = outgoingEdges[nodeId] || [];

    if (nodeType === 'decide') {
      decideNodes += 1;
      const config = (node.data || {}).config || {};
      const conditions = config.conditions;
      if (!Array.isArray(conditions) || conditions.length === 0) {
        errors.push(`decide node ${nodeId} must have config.conditions[]`);
        return;
      }

      const conditionLabels = conditions
        .map((condition) => condition.label)
        .filter((label) => typeof label === 'string' && label.trim() !== '');

      const uniqueLabels = new Set(conditionLabels);
      if (uniqueLabels.size !== conditionLabels.length) {
        errors.push(`decide node ${nodeId} has duplicate condition labels`);
      }

      conditionLabels.forEach((label) => {
        if (!outgoing.includes(label)) {
          errors.push(`decide node ${nodeId} missing outgoing edge for label "${label}"`);
        }
      });

      outgoing.forEach((label) => {
        if (!uniqueLabels.has(label)) {
          warnings.push(`decide node ${nodeId} has edge label "${label}" not in conditions`);
        }
      });

      return;
    }

    if (outgoing.length > 1) {
      errors.push(`node ${nodeId} has ${outgoing.length} outgoing edges; only decide nodes can branch`);
    }
    if (outgoing.length === 1 && outgoing[0] !== 'next') {
      errors.push(`node ${nodeId} outgoing edge label must be "next"`);
    }
  });

  return {
    errors,
    warnings,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      decideNodes
    }
  };
}

function usage() {
  return ok({
    usage: 'node scripts/validate-graph.js --workflow-id <id> | --definition-file <path> | --definition-json <json>',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const workflowId = getFlag(parsed.flags, 'workflow-id');
  const definitionFile = getFlag(parsed.flags, 'definition-file');
  const definitionJson = getFlag(parsed.flags, 'definition-json');

  let definition = null;
  let source = 'definition-input';

  if (workflowId) {
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
    definition = workflow && typeof workflow === 'object' ? workflow.definition : null;
    if (!definition || typeof definition !== 'object') {
      printJson(err('Workflow definition missing in response', response.raw, false, response.status));
      return 2;
    }

    source = `workflow:${workflowId}`;
  } else if (definitionFile) {
    definition = parseDefinitionInput(readFileText(definitionFile));
    if (!definition) {
      printJson(err('Unable to parse workflow definition from definition-file'));
      return 2;
    }
    source = definitionFile;
  } else if (definitionJson) {
    definition = parseDefinitionInput(definitionJson);
    if (!definition) {
      printJson(err('Unable to parse workflow definition from definition-json'));
      return 2;
    }
  }

  if (!definition) {
    printJson(err('Provide --workflow-id, --definition-file, or --definition-json'));
    return 2;
  }

  const validation = validateDefinition(definition);

  printJson(ok({
    source,
    valid: validation.errors.length === 0,
    errors: validation.errors,
    warnings: validation.warnings,
    stats: validation.stats
  }));

  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
