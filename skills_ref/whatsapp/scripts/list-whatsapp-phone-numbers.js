#!/usr/bin/env node
import { loadConfig, requestJson } from './lib/workflows/kapso-api.js';
import { ok, err, printJson } from './lib/workflows/result.js';
import { parseArgs, getBooleanFlag, getNumberFlag } from './lib/workflows/args.js';

function usage() {
  return ok({
    usage: 'node scripts/list-whatsapp-phone-numbers.js [--per-page <n>] [--page <n>]',
    env: ['KAPSO_API_BASE_URL', 'KAPSO_API_KEY']
  });
}

function extractPhoneNumbers(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.phone_numbers)) return payload.phone_numbers;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (getBooleanFlag(parsed.flags, 'help') || getBooleanFlag(parsed.flags, 'h')) {
    printJson(usage());
    return 0;
  }

  const config = loadConfig();
  const response = await requestJson(config, {
    method: 'GET',
    path: '/platform/v1/whatsapp/phone_numbers',
    query: {
      per_page: getNumberFlag(parsed.flags, 'per-page'),
      page: getNumberFlag(parsed.flags, 'page')
    }
  });

  if (!response.ok) {
    printJson(err('Failed to list WhatsApp phone numbers', response.raw, false, response.status));
    return 2;
  }

  const payload = response.data;
  const phoneNumbers = extractPhoneNumbers(payload);

  printJson(ok({
    phone_numbers: phoneNumbers,
    raw: payload,
    note: 'Use phone_number_id for inbound_message triggers.'
  }));
  return 0;
}

main().catch((error) => {
  printJson(err('Unhandled error', { message: String(error?.message || error) }));
  process.exit(1);
});
