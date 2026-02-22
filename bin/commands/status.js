/**
 * cli-claw status — Phase 9.1
 * Checks if the server is running by pinging the API.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
        port: { type: 'string', default: process.env.PORT || '3457' },
        json: { type: 'boolean', default: false },
    },
    strict: false,
});

const url = `http://localhost:${values.port}/api/settings`;

try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
        const data = await res.json();
        if (values.json) {
            console.log(JSON.stringify({ status: 'running', port: values.port, cli: data.cli }));
        } else {
            console.log(`  🦞 Server is running on port ${values.port}`);
            console.log(`  CLI: ${data.cli}`);
            console.log(`  Working dir: ${data.workingDir || '~'}`);

            // Heartbeat status
            try {
                const hbRes = await fetch(`http://localhost:${values.port}/api/heartbeat`, { signal: AbortSignal.timeout(2000) });
                const hb = await hbRes.json();
                const active = (hb.jobs || []).filter(j => j.enabled).length;
                console.log(`  Heartbeat: ${active} job${active !== 1 ? 's' : ''} active`);
            } catch { }
        }
    } else {
        console.log(`  ⚠️ Server responded with ${res.status}`);
        process.exitCode = 1;
    }
} catch {
    if (values.json) {
        console.log(JSON.stringify({ status: 'stopped' }));
    } else {
        console.log(`  ❌ Server not running (port ${values.port})`);
    }
    process.exitCode = 1;
}
