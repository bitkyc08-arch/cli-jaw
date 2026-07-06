// ── Widget HTML Validator ──
// Client-side validation for AI-generated diagram-html before iframe injection.
// Defense-in-depth layer on top of sandbox="allow-scripts" + CSP.

const CDN_ALLOWLIST = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bdocument\.cookie\b/,
  /\bwindow\.opener\b/,
  /\bwindow\.top\b/,
  /\bparent\.postMessage\b(?!.*jaw-)/,
  /\blocation\.href\s*=/,
  /\bwindow\.location\b/,
  /\bsetTimeout\s*\(\s*["'`]/,
  /\bsetInterval\s*\(\s*["'`]/,
  /\.constructor\s*\.\s*constructor/,
  /\bdocument\.write\s*\(/,
  /\binsertAdjacentHTML\s*\(/,
];

// No warn-only patterns currently — innerHTML removed (too common in onerror fallbacks)
const WARN_PATTERNS: readonly RegExp[] = [];

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  warnings: string[];
}

const DEFAULT_MAX_BYTES = 524_288;

function htmlByteLength(html: string): number {
  return new TextEncoder().encode(html).length;
}

function formatMaxBytes(maxBytes: number): string {
  if (maxBytes === DEFAULT_MAX_BYTES) return '512KB';
  if (maxBytes % 1_048_576 === 0) return `${maxBytes / 1_048_576}MB`;
  if (maxBytes % 1024 === 0) return `${maxBytes / 1024}KB`;
  return `${maxBytes} bytes`;
}

export function validateWidgetHtml(html: string, opts: { maxBytes?: number } = {}): ValidationResult {
  const warnings: string[] = [];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // 1. Size cap (redundant with activateWidgets but defense-in-depth)
  if (htmlByteLength(html) > maxBytes) {
    return { valid: false, reason: `Payload too large (>${formatMaxBytes(maxBytes)})`, warnings };
  }

  // 2. External URL validation — only allowlisted CDN domains
  const urlPattern = /(?:src|href)\s*=\s*["']https?:\/\/([^/"']+)/gi;
  let match;
  while ((match = urlPattern.exec(html)) !== null) {
    const domain = match[1];
    if (!CDN_ALLOWLIST.some(a => domain === a || domain.endsWith('.' + a))) {
      return { valid: false, reason: `Blocked domain: ${domain}`, warnings };
    }
  }

  // 3. CSS url() with external resources
  const cssUrlPattern = /url\s*\(\s*['"]?https?:\/\/([^)'"]+)/gi;
  while ((match = cssUrlPattern.exec(html)) !== null) {
    const domain = match[1].split('/')[0];
    if (!CDN_ALLOWLIST.some(a => domain === a || domain.endsWith('.' + a))) {
      warnings.push(`CSS url() references external domain: ${domain}`);
    }
  }

  // 4. Dangerous patterns — block
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(html)) {
      return { valid: false, reason: `Dangerous pattern: ${pattern.source}`, warnings };
    }
  }

  // 4b. Dynamic import() — allow only with allowlisted CDN string literals
  const importPattern = /\bimport\s*\(\s*['"`](.*?)['"`]\s*\)/g;
  let importMatch;
  while ((importMatch = importPattern.exec(html)) !== null) {
    try {
      const importDomain = new URL(importMatch[1]).hostname;
      if (!CDN_ALLOWLIST.some(a => importDomain === a || importDomain.endsWith('.' + a))) {
        return { valid: false, reason: `Blocked import() domain: ${importDomain}`, warnings };
      }
    } catch {
      return { valid: false, reason: 'Dynamic import() with non-URL argument', warnings };
    }
  }
  // Block bare import() with variable/expression (no string literal)
  const bareImport = /\bimport\s*\(\s*(?!['"`])/g;
  if (bareImport.test(html)) {
    return { valid: false, reason: 'Dynamic import() with non-literal argument', warnings };
  }

  // 5. Warning-only patterns
  for (const pattern of WARN_PATTERNS) {
    if (pattern.test(html)) {
      warnings.push(`DOM sink detected: ${pattern.source}`);
    }
  }

  return { valid: true, warnings };
}
