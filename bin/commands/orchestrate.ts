#!/usr/bin/env node
// bin/commands/orchestrate.ts — CLI: jaw orchestrate [P|A|B|C|D]
// Calls the running server's API so WS broadcast reaches all clients in real-time.

import { settings } from '../../src/core/config.js';

// Derive port: --port flag > env > settings > 3457
const portIdx = process.argv.indexOf('--port');
const PORT = (portIdx !== -1 && process.argv[portIdx + 1]) ? process.argv[portIdx + 1] : (process.env.PORT || '3457');
const BASE = `http://localhost:${PORT}`;

const target = (process.argv[3] || 'P').toUpperCase();
const valid = ['P', 'A', 'B', 'C', 'D'];

if (!valid.includes(target)) {
  console.error(`Invalid state: ${target}. Must be one of: ${valid.join(', ')}`);
  process.exit(1);
}

try {
  const res = await fetch(`${BASE}/api/orchestrate/state`, {
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
