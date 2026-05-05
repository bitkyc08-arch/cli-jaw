#!/usr/bin/env node
// bin/commands/orchestrate.ts — CLI: jaw orchestrate [P|A|B|C|D|status|reset]
// Calls the running server's API so WS broadcast reaches all clients in real-time.

import { settings, loadSettings, getServerUrl } from '../../src/core/config.js';
import { cliFetch, getCliAuthToken } from '../../src/cli/api-auth.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';
import { errString, isConnRefused } from '../_http-client.js';
import type { OrcContext } from '../../src/orchestrator/state-machine.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw orchestrate — PABCD state machine transitions

  Usage: jaw orchestrate <phase>

  Phases:
    P       Enter Planning (from IDLE)
    A       Enter Plan Audit (from P)
    B       Enter Build (from A)
    C       Enter Check (from B)
    D       Enter Done (from C, returns to IDLE)
    status  Show current phase
    reset   Return to IDLE from any state

  Transitions: P -> A -> B -> C -> D -> IDLE (one-way only).
`);

loadSettings();

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
      const port = argv[++i];
      if (port !== undefined) parsed.port = port;
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

interface OrchestrateStatusBody {
  ok?: boolean;
  error?: string;
  scope?: string;
  state?: string;
  ctx?: Partial<OrcContext> | null;
}

function formatStatus(body: OrchestrateStatusBody): string {
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
    const body = await res.json() as OrchestrateStatusBody;
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
    const body = await res.json() as OrchestrateStatusBody;
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

  const body = await res.json() as OrchestrateStatusBody;

  if (!res.ok) {
    console.error(body.error || `Failed: ${res.status}`);
    try {
      const stateRes = await cliFetch(`${BASE}/api/orchestrate/state`);
      const stateBody = await stateRes.json() as OrchestrateStatusBody;
      if (stateRes.ok) console.error(`Current server state: ${stateBody.state || 'UNKNOWN'}`);
    } catch {
      // Keep the original transition error as the primary failure.
    }
    process.exit(1);
  }

  console.log(`✅ State → ${body.state || target}`);

  // Also print the state prompt for context
  const { getStatePrompt } = await import('../../src/orchestrator/state-machine.js');
  console.log(getStatePrompt(target));
} catch (e: unknown) {
  if (isConnRefused(e)) {
    console.error(`Server not running on port ${PORT}. Start with: jaw serve --port ${PORT}`);
  } else {
    console.error(`Error: ${errString(e)}`);
  }
  process.exit(1);
}
