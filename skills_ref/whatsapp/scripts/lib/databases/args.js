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

function parseJsonObject(value, name) {
  if (value === undefined || value === true) {
    throw new Error(`Missing required JSON for --${name}`);
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON for --${name}: ${String(error)}`);
  }
}

function parseJsonObjectOptional(value, name) {
  if (value === undefined || value === true) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON for --${name}: ${String(error)}`);
  }
}

function parseNumber(value, name) {
  if (value === undefined || value === true) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for --${name}: ${value}`);
  }
  return parsed;
}

export {
  hasHelpFlag,
  parseFlags,
  requireFlag,
  parseJsonObject,
  parseJsonObjectOptional,
  parseNumber
};
