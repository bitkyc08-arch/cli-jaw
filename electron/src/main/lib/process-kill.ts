// Reuse the server-side implementation instead of duplicating the pgrep walk.
// Codex-style children spawn with their own PGIDs, so process.kill(-pid) alone
// is not enough — see src/agent/spawn/process-kill.ts.
export { killProcessTree } from '../../../../src/agent/spawn/process-kill.js';
