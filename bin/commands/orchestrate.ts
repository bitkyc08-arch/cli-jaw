#!/usr/bin/env node
// bin/commands/orchestrate.ts — CLI: jaw orchestrate [P|A|B|C|D|reset]
// Calls the running server's API so WS broadcast reaches all clients in real-time.

import { settings, loadSettings, getServerUrl } from '../../src/core/config.js';
import { cliFetch, getCliAuthToken } from '../../src/cli/api-auth.js';

loadSettings();  // ensure settings.port is loaded from this instance's settings.json

// Derive port: --port flag > env > settings.port > 3457
const portIdx = process.argv.indexOf('--port');
const PORT = (portIdx !== -1 && process.argv[portIdx + 1]) ? process.argv[portIdx + 1] : undefined;
const BASE = getServerUrl(PORT);

const target = (process.argv[3] || 'P').toUpperCase();
const valid = ['P', 'A', 'B', 'C', 'D', 'RESET'];

if (!valid.includes(target)) {
  console.error(`Invalid state: ${target}. Must be one of: P, A, B, C, D, reset`);
  process.exit(1);
}

await getCliAuthToken(PORT);
try {
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
    body: JSON.stringify({ state: target }),
  });

  const body = await res.json() as any;

  if (!res.ok) {
    console.error(body.error || `Failed: ${res.status}`);
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

