function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function normalizeBaseUrl(raw) {
  return raw.replace(/\/+$/, '');
}

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function validateBaseUrl(baseUrl) {
  if (!baseUrl) return;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new Error(`Invalid KAPSO_API_BASE_URL: ${baseUrl}`);
  }
  if (!process.env.KAPSO_API_ALLOW_LOCALHOST && isLocalhost(parsed.hostname)) {
    throw new Error(
      `KAPSO_API_BASE_URL points to localhost (${parsed.hostname}). ` +
      'Set KAPSO_API_ALLOW_LOCALHOST=true if this is intentional.'
    );
  }
}

export function loadConfig(options = {}) {
  const requireApi = options.requireApi !== false;

  const rawBaseUrl = requireApi ? requireEnv('KAPSO_API_BASE_URL') : (process.env.KAPSO_API_BASE_URL || '');
  const baseUrl = rawBaseUrl ? normalizeBaseUrl(rawBaseUrl) : '';
  validateBaseUrl(baseUrl);
  const apiKey = requireApi ? requireEnv('KAPSO_API_KEY') : (process.env.KAPSO_API_KEY || '');

  return { baseUrl, apiKey };
}

function buildUrl(baseUrl, path) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const safePath = path.startsWith('/') ? path.slice(1) : path;
  return `${trimmed}/${safePath}`;
}

export async function requestJson(config, options) {
  const url = new URL(buildUrl(config.baseUrl, options.path));

  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }

  const headers = {
    Accept: 'application/json'
  };

  if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
  }

  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method: options.method,
      headers,
      body
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: 'Network error while calling Kapso API',
      raw: { message: String(error?.message || error), url: url.toString() }
    };
  }

  const text = await response.text();
  let parsed = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (response.ok) {
    const data = (parsed && typeof parsed === 'object' && 'data' in parsed)
      ? parsed.data
      : parsed;

    return {
      ok: true,
      status: response.status,
      data,
      raw: parsed
    };
  }

  const message = (parsed && typeof parsed === 'object' && 'error' in parsed)
    ? String(parsed.error)
    : `HTTP ${response.status}`;

  return {
    ok: false,
    status: response.status,
    error: message,
    raw: parsed
  };
}
