export function parseArgs(argv) {
  const flags = {};
  const args = [];

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const trimmed = token.slice(2);
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex !== -1) {
        const key = trimmed.slice(0, eqIndex);
        const value = trimmed.slice(eqIndex + 1);
        flags[key] = value;
        i += 1;
        continue;
      }

      const key = trimmed;
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
        i += 1;
      } else {
        flags[key] = next;
        i += 2;
      }
      continue;
    }

    args.push(token);
    i += 1;
  }

  return { args, flags };
}

export function getFlag(flags, name) {
  const value = flags[name];
  if (typeof value === 'string') return value;
  return undefined;
}

export function getBooleanFlag(flags, name) {
  return Boolean(flags[name]);
}

export function getNumberFlag(flags, name) {
  const value = getFlag(flags, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
