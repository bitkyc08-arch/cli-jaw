#!/usr/bin/env node
// bin/commands/orchestrate.ts — CLI: jaw orchestrate [P|A|B|C|D]

import { getState, setState, resetState, canTransition, getStatePrompt, type OrcStateName, type OrcContext } from '../../src/orchestrator/state-machine.js';

const target = (process.argv[3] || '').toUpperCase() as OrcStateName;
const current = getState();

// No argument = enter P from IDLE
if (!target || target === 'P') {
  if (current !== 'IDLE') {
    console.error(`Cannot enter P: currently in ${current}. Reset first.`);
    process.exit(1);
  }
  // Initialize context with available info (agent fills in details later)
  const ctx: OrcContext = {
    originalPrompt: process.argv.slice(4).join(' ') || '',
    plan: null,
    workerResults: [],
    origin: process.env.JAW_ORIGIN || 'cli',
  };
  setState('P', ctx);
  console.log(getStatePrompt('P'));
  process.exit(0);
}

// D → IDLE (auto-reset, with guard)
if (target === 'D') {
  if (!canTransition(current, 'D')) {
    console.error(`Cannot transition to D: currently in ${current}. Must be in C first.`);
    process.exit(1);
  }
  setState('D');
  console.log(getStatePrompt('D'));
  resetState();
  process.exit(0);
}

// General transition with guard
if (!canTransition(current, target)) {
  console.error(`Invalid transition: ${current} → ${target}`);
  console.error(`Valid: ${['P','A','B','C','D'].filter(t => canTransition(current, t as OrcStateName)).join(', ') || 'none'}`);
  process.exit(1);
}

setState(target);
console.log(getStatePrompt(target));
