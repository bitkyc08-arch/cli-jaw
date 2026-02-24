import { hasHelpFlag, parseFlags, requireFlag } from './lib/functions/args.js';
import { kapsoConfigFromEnv, kapsoRequest } from './lib/functions/kapso-api.js';

function ok(data) {
  return { ok: true, data };
}

function err(message, details) {
  return { ok: false, error: { message, details } };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          usage:
            'node scripts/list-function-invocations.js --function-id <id> [--status <success|failed>] [--limit <n>]',
          env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
        },
        null,
        2
      )
    );
    return 0;
  }

  try {
    const flags = parseFlags(argv);
    const functionId = requireFlag(flags, 'function-id');
    const params = new URLSearchParams();

    if (flags.status) params.set('status', flags.status);
    if (flags.limit) params.set('limit', flags.limit);

    const config = kapsoConfigFromEnv();
    const data = await kapsoRequest(
      config,
      `/platform/v1/functions/${encodeURIComponent(functionId)}/invocations${params.toString() ? `?${params.toString()}` : ''}`
    );

    console.log(JSON.stringify(ok(data), null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(err('Command failed', { message }), null, 2));
    return 1;
  }
}

main().then((code) => process.exit(code));
