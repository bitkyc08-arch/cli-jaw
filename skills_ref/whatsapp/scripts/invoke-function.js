import { readFileSync } from 'node:fs';
import { kapsoConfigFromEnv, kapsoRequest } from './lib/functions/kapso-api.js';
import { hasHelpFlag, parseFlags, requireFlag, parseJsonValue } from './lib/functions/args.js';

function ok(data) {
  return { ok: true, data };
}

function err(message, details) {
  return { ok: false, error: { message, details } };
}

function resolvePayload(flags) {
  if (typeof flags.payload === 'string' && flags.payload.length > 0) {
    return parseJsonValue(flags.payload, 'payload');
  }
  if (typeof flags['payload-file'] === 'string' && flags['payload-file'].length > 0) {
    return JSON.parse(readFileSync(flags['payload-file'], 'utf8'));
  }
  throw new Error('Provide --payload or --payload-file');
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          usage:
            'node scripts/invoke-function.js --function-id <id> (--payload <json> | --payload-file <path>)',
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
    const payload = resolvePayload(flags);
    const config = kapsoConfigFromEnv();
    const data = await kapsoRequest(config, `/platform/v1/functions/${encodeURIComponent(functionId)}/invoke`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    console.log(JSON.stringify(ok(data), null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(err('Command failed', { message }), null, 2));
    return 1;
  }
}

main().then((code) => process.exit(code));
