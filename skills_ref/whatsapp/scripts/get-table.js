import { kapsoConfigFromEnv, kapsoRequest } from './lib/databases/kapso-api.js';
import { hasHelpFlag, parseFlags, requireFlag, parseNumber } from './lib/databases/args.js';

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
          usage: 'node scripts/get-table.js --table <name> [--limit <n>]',
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
    const table = requireFlag(flags, 'table');
    const limit = parseNumber(flags.limit, 'limit');
    const query = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
    const config = kapsoConfigFromEnv();
    const data = await kapsoRequest(config, `/platform/v1/database_tables/${encodeURIComponent(table)}${query}`);
    console.log(JSON.stringify(ok(data), null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(err('Command failed', { message }), null, 2));
    return 1;
  }
}

main().then((code) => process.exit(code));
