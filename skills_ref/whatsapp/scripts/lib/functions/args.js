function hasHelpFlag(argv) {
  return argv.includes('--help') || argv.includes('-h');
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const trimmed = arg.slice(2);
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex >= 0) {
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      flags[key] = value;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[trimmed] = true;
      continue;
    }
    flags[trimmed] = next;
    index += 1;
  }
  return flags;
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function parseJsonValue(value, name) {
  if (value === undefined || value === true) {
    throw new Error(`Missing required JSON for --${name}`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for --${name}: ${String(error)}`);
  }
}

export {
  hasHelpFlag,
  parseFlags,
  requireFlag,
  parseJsonValue
};
