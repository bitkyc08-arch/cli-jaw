#!/usr/bin/env node
// bin/commands/orchestrate.ts — CLI: jaw orchestrate [P|A|B|C|D|status|reset]
// Calls the running server's API so WS broadcast reaches all clients in real-time.

import { settings, loadSettings, getServerUrl } from '../../src/core/config.js';
import { cliFetch, getCliAuthToken } from '../../src/cli/api-auth.js';

loadSettings();  // ensure settings.port is loaded from this instance's settings.json

interface Args {
  target: string;
  port?: string;
  force: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = { target: 'P', force: false, json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--port') {
      parsed.port = argv[++i];
    } else if (arg?.startsWith('--port=')) {
      parsed.port = arg.slice('--port='.length);
    } else if (arg?.startsWith('--')) {
      // Unknown flags are ignored here so the server remains the authority for
      // transition validity. This preserves the existing small CLI surface.
    } else if (arg) {
      positional.push(arg);
    }
  }
  parsed.target = (positional[0] || 'P').toUpperCase();
  return parsed;
}

function formatStatus(body: any): string {
  const ctx = body.ctx || {};
  return [
    `State: ${body.state || 'UNKNOWN'}`,
    `Scope: ${body.scope || 'default'}`,
    `Audit: ${ctx.auditStatus || 'none'}`,
    `Verification: ${ctx.verificationStatus || 'none'}`,
    `User approved: ${ctx.userApproved ? 'yes' : 'no'}`,
    `Plan: ${ctx.plan ? 'present' : 'none'}`,
    `Worklog: ${ctx.worklogPath || 'none'}`,
    `Plan hash: ${ctx.planHash || 'none'}`,
  ].join('\n');
}

const parsed = parseArgs(process.argv.slice(3));
const PORT = parsed.port;
const BASE = getServerUrl(PORT);

const target = parsed.target;
const valid = ['P', 'A', 'B', 'C', 'D', 'RESET', 'STATUS'];

if (!valid.includes(target)) {
  console.error(`Invalid state: ${target}. Must be one of: P, A, B, C, D, status, reset`);
  process.exit(1);
}

await getCliAuthToken(PORT);
try {
  if (target === 'STATUS') {
    const res = await cliFetch(`${BASE}/api/orchestrate/state`);
    const body = await res.json() as any;
    if (!res.ok) {
      console.error(body.error || `Failed: ${res.status}`);
      process.exit(1);
    }
    console.log(parsed.json ? JSON.stringify(body, null, 2) : formatStatus(body));
    process.exit(0);
  }

  // Reset: return to IDLE from any state
  if (target === 'RESET') {
    const res = await cliFetch(`${BASE}/api/orchestrate/reset`, { method: 'POST' });
    const body = await res.json() as any;
    if (!res.ok) {
      console.error(body.error || `Failed: ${res.status}`);
      process.exit(1);
    }
    console.log('✅ State → IDLE (reset)');
    process.exit(0);
  }

  // State transition: P|A|B|C|D
  const res = await cliFetch(`${BASE}/api/orchestrate/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: target, userInitiated: true, ...(parsed.force ? { force: true } : {}) }),
  });

  const body = await res.json() as any;

  if (!res.ok) {
    console.error(body.error || `Failed: ${res.status}`);
    try {
      const stateRes = await cliFetch(`${BASE}/api/orchestrate/state`);
      const stateBody = await stateRes.json() as any;
      if (stateRes.ok) console.error(`Current server state: ${stateBody.state || 'UNKNOWN'}`);
    } catch {
      // Keep the original transition error as the primary failure.
    }
    process.exit(1);
  }

  console.log(`✅ State → ${body.state || target}`);

  // Also print the state prompt for context
  const { getStatePrompt } = await import('../../src/orchestrator/state-machine.js');
  console.log(getStatePrompt(target as any));
} catch (e: any) {
  if (e.cause?.code === 'ECONNREFUSED') {
    console.error(`Server not running on port ${PORT}. Start with: jaw serve --port ${PORT}`);
  } else {
    console.error(`Error: ${e.message}`);
  }
  process.exit(1);
}
