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

function kapsoConfigFromEnv() {
  const baseUrl = normalizeBaseUrl(requireEnv('KAPSO_API_BASE_URL'));
  validateBaseUrl(baseUrl);
  return {
    baseUrl,
    apiKey: requireEnv('KAPSO_API_KEY')
  };
}

async function kapsoRequest(config, path, init = {}) {
  const url = `${config.baseUrl}${path}`;
  const headers = new Headers(init.headers || undefined);
  headers.set('X-API-Key', config.apiKey);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    throw new Error(
      `Kapso API request failed (network error) url=${url} error=${String(error?.message || error)}`
    );
  }
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Kapso API request failed (status=${response.status}) body=${text}`);
  }

  return text ? JSON.parse(text) : {};
}

export {
  kapsoConfigFromEnv,
  kapsoRequest
};
