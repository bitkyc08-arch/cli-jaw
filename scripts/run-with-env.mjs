// Cross-platform env-prefixed script runner (#383). npm scripts on Windows run
// under cmd.exe, where the POSIX `VAR=value cmd` prefix is not syntax - it
// fails with "'VAR' is not recognized". Usage:
//   node scripts/run-with-env.mjs VAR=value [VAR2=value2 ...] -- <cmd> [args...]
// The command runs through the current Node when it is a .mjs/.cjs/.js/.ts
// entry resolved via node_modules, else spawned directly.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1) {
    console.error('usage: node scripts/run-with-env.mjs VAR=value ... -- <cmd> [args...]');
    process.exit(2);
}
const env = { ...process.env };
for (const pair of argv.slice(0, sep)) {
    const eq = pair.indexOf('=');
    if (eq === -1) { console.error(`not a VAR=value pair: ${pair}`); process.exit(2); }
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
}
const [cmd, ...args] = argv.slice(sep + 1);
const require = createRequire(import.meta.url);
// tsx runs through its JS entry so no .cmd shim is involved (#381/#382).
const spec = cmd === 'tsx'
    ? { file: process.execPath, args: [require.resolve('tsx/cli'), ...args] }
    : { file: cmd, args };
const child = spawn(spec.file, spec.args, { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
child.on('error', (err) => { console.error(err.message); process.exit(1); });
