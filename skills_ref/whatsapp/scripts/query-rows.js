import { kapsoConfigFromEnv, kapsoRequest } from './lib/databases/kapso-api.js';
import { hasHelpFlag, parseFlags, requireFlag, parseJsonObjectOptional, parseNumber } from './lib/databases/args.js';

function ok(data) {
  return { ok: true, data };
}

function err(message, details) {
  return { ok: false, error: { message, details } };
}

function buildQuery(flags) {
  const params = new URLSearchParams();
  const filters = parseJsonObjectOptional(flags.filters, 'filters');
  if (filters) {
    Object.entries(filters).forEach(([key, value]) => {
      params.set(key, String(value));
    });
  }
  if (typeof flags.select === 'string' && flags.select.length > 0) {
    params.set('select', flags.select);
  }
  if (typeof flags.order === 'string' && flags.order.length > 0) {
    params.set('order', flags.order);
  }
  const limit = parseNumber(flags.limit, 'limit');
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  const offset = parseNumber(flags.offset, 'offset');
  if (offset !== undefined) {
    params.set('offset', String(offset));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          usage:
            'node scripts/query-rows.js --table <name> [--filters <json>] [--select <cols>] [--order <col.asc|desc>] [--limit <n>] [--offset <n>]',
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
    const query = buildQuery(flags);
    const config = kapsoConfigFromEnv();
    const data = await kapsoRequest(config, `/platform/v1/db/${encodeURIComponent(table)}${query}`);
    console.log(JSON.stringify(ok(data), null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(err('Command failed', { message }), null, 2));
    return 1;
  }
}

main().then((code) => process.exit(code));
