#!/usr/bin/env node
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getFlag, getBooleanFlag, getNumberFlag } from './lib/workflows/args.js';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripCodeFences(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    const withoutFirst = trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, '');
    return withoutFirst.replace(/```$/, '').trim();
  }
  return text;
}

function stripLineNumbers(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\s*\|\s?/, '').replace(/^\s*\d+:\s?/, ''))
    .join('\n');
}

function normalizeEditText(text) {
  return normalizeLineEndings(stripLineNumbers(stripCodeFences(text)));
}

function readFileText(path) {
  return readFileSync(path, 'utf8');
}

function loadTextInput(flags, valueFlag, fileFlag) {
  const filePath = getFlag(flags, fileFlag);
  if (filePath) {
    return readFileText(filePath);
  }
  return getFlag(flags, valueFlag);
}

function isEscaped(text, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function insideJsonString(text, index) {
  let inString = false;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '"' && !isEscaped(text, i)) {
      inString = !inString;
    }
  }
  return inString;
}

function unescapeCLike(text) {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function jsonStringContent(text) {
  const json = JSON.stringify(text);
  return json.slice(1, -1);
}

function replaceAllOccurrences(content, search, newText) {
  let result = '';
  let index = 0;
  let replacementsInJson = 0;
  let replacementsOutsideJson = 0;

  while (true) {
    const matchIndex = content.indexOf(search, index);
    if (matchIndex === -1) {
      result += content.slice(index);
      break;
    }

    const insideString = insideJsonString(content, matchIndex);
    const replacement = insideString
      ? jsonStringContent(unescapeCLike(newText))
      : newText;

    result += content.slice(index, matchIndex) + replacement;
    index = matchIndex + search.length;

    if (insideString) {
      replacementsInJson += 1;
    } else {
      replacementsOutsideJson += 1;
    }
  }

  return {
    content: result,
    replacements: replacementsInJson + replacementsOutsideJson,
    replacements_in_json_strings: replacementsInJson,
    replacements_outside_json_strings: replacementsOutsideJson
  };
}

function applyReplacement(content, oldText, newText, replaceAll) {
  if (oldText === newText) {
    throw new Error('old and new text must be different');
  }

  const candidates = [
    { label: 'raw', value: oldText },
    { label: 'unescaped', value: oldText.replace(/\\n/g, '\n') },
    { label: 'escaped', value: oldText.replace(/\n/g, '\\n') }
  ];

  const seen = new Set();
  const uniqueCandidates = candidates.filter((candidate) => {
    if (seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });

  for (const candidate of uniqueCandidates) {
    if (!candidate.value) continue;
    const firstIndex = content.indexOf(candidate.value);
    if (firstIndex === -1) continue;

    if (replaceAll) {
      const replaced = replaceAllOccurrences(content, candidate.value, newText);
      return { ...replaced, matchedVariant: candidate.label };
    }

    const lastIndex = content.lastIndexOf(candidate.value);
    if (firstIndex !== lastIndex) {
      throw new Error('old text matches multiple locations; use --replace-all or narrow the match');
    }

    const insideString = insideJsonString(content, firstIndex);
    const replacement = insideString
      ? jsonStringContent(unescapeCLike(newText))
      : newText;

    const updated = content.replace(candidate.value, replacement);
    return {
      content: updated,
      replacements: 1,
      replacements_in_json_strings: insideString ? 1 : 0,
      replacements_outside_json_strings: insideString ? 0 : 1,
      matchedVariant: candidate.label
    };
  }

  throw new Error('old text not found in workflow graph');
}

function usage() {
  return ok({
    usage: 'node scripts/edit-graph.js <workflow-id> --expected-lock-version <n> --old <text>|--old-file <path> --new <text>|--new-file <path> [--replace-all]',
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

  const oldInput = loadTextInput(parsed.flags, 'old', 'old-file');
  const newInput = loadTextInput(parsed.flags, 'new', 'new-file');
  if (!oldInput || !newInput) {
    printJson(err('old/new text is required (use --old/--new or --old-file/--new-file)'));
    return 2;
  }

  const replaceAll = getBooleanFlag(parsed.flags, 'replace-all');

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

  const currentLock = workflow.lock_version;
  if (currentLock !== expectedLockVersion) {
    printJson(err('Conflict: workflow was modified. Refetch and retry.', {
      expected_lock_version: expectedLockVersion,
      current_lock_version: currentLock
    }));
    return 2;
  }

  const pretty = JSON.stringify(definition, null, 2);
  const beforeHash = sha256(pretty);
  const oldText = normalizeEditText(oldInput);
  const newText = normalizeEditText(newInput);

  let editResult;
  try {
    editResult = applyReplacement(pretty, oldText, newText, replaceAll);
  } catch (error) {
    printJson(err(String(error?.message || error)));
    return 2;
  }

  let updatedDefinition;
  try {
    updatedDefinition = JSON.parse(editResult.content);
  } catch (error) {
    printJson(err('Invalid JSON after replacement', { message: String(error?.message || error) }));
    return 2;
  }

  const update = await requestJson(config, {
    method: 'PATCH',
    path: `/platform/v1/workflows/${workflowId}`,
    body: {
      workflow: {
        definition: updatedDefinition
      }
    }
  });

  if (!update.ok) {
    printJson(err('Failed to update workflow definition', update.raw, false, update.status));
    return 2;
  }

  printJson(ok({
    workflow_id: workflowId,
    replacements_count: editResult.replacements,
    replacements_in_json_strings: editResult.replacements_in_json_strings,
    replacements_outside_json_strings: editResult.replacements_outside_json_strings,
    matched_variant: editResult.matchedVariant,
    workflow_graph_sha256_before: beforeHash,
    workflow_graph_sha256_after: sha256(editResult.content),
    update: {
      id: update.data.id,
      name: update.data.name,
      status: update.data.status,
      lock_version: update.data.lock_version,
      updated_at: update.data.updated_at
    }
  }));

  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
