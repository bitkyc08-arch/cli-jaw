import { readFileSync } from 'node:fs';
import { kapsoConfigFromEnv, kapsoRequest } from './lib/functions/kapso-api.js';
import { hasHelpFlag, parseFlags, requireFlag } from './lib/functions/args.js';

function ok(data) {
  return { ok: true, data };
}

function err(message, details) {
  return { ok: false, error: { message, details } };
}

function resolveCode(flags) {
  if (typeof flags.code === 'string' && flags.code.length > 0) {
    return flags.code;
  }
  if (typeof flags['code-file'] === 'string' && flags['code-file'].length > 0) {
    return readFileSync(flags['code-file'], 'utf8');
  }
  throw new Error('Provide --code or --code-file');
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          usage:
            'node scripts/create-function.js --name <name> (--code <js> | --code-file <path>) [--description <text>]',
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
    const name = requireFlag(flags, 'name');
    const code = resolveCode(flags);
    const payload = { name, code };
    if (typeof flags.description === 'string' && flags.description.length > 0) {
      payload.description = flags.description;
    }
    const config = kapsoConfigFromEnv();
    const data = await kapsoRequest(config, '/platform/v1/functions', {
      method: 'POST',
      body: JSON.stringify({ function: payload })
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
