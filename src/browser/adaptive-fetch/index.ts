import type { AdaptiveFetchOptions, BrowserMode, IdentityMode } from './types.js';
import { parseArgs } from 'node:util';
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from './safety.js';
import { executeAdaptiveFetch } from './scheduler.js';
import { compactAdaptiveFetchResult, writeStdoutLine } from './output.js';

const BROWSER_MODES = new Set(['auto', 'never', 'required']);
const BROWSER_SESSIONS = new Set(['none', 'isolated', 'existing', 'user', 'interactive']);
const IDENTITY_MODES = new Set(['auto', 'minimal', 'chrome']);

export function normalizeAdaptiveFetchOptions(raw: Record<string, unknown> = {}): AdaptiveFetchOptions {
    const browserMode = normalizeEnum(raw['browserMode'] || raw['browser'], BROWSER_MODES, 'auto', 'browser') as BrowserMode;
    const rawSession = raw['browserSession'];
    const browserSession = normalizeEnum(rawSession, BROWSER_SESSIONS, browserMode === 'never' ? 'none' : 'isolated', 'browserSession');
    const identity = normalizeEnum(raw['identity'], IDENTITY_MODES, 'auto', 'identity') as IdentityMode;
    const userSessionExplicit = browserSession === 'user' || browserSession === 'interactive';
    const humanLoop = browserSession === 'interactive';
    const result: AdaptiveFetchOptions = {
        url: typeof raw['url'] === 'string' ? raw['url'] : '',
        json: Boolean(raw['json']),
        trace: Boolean(raw['trace']),
        browserMode,
        browserSession: userSessionExplicit ? 'existing' : browserSession,
        identity,
        userSessionExplicit,
        humanLoop,
        browserSessionRaw: browserSession,
        maxBytes: positiveInteger(raw['maxBytes'], DEFAULT_MAX_BYTES),
        timeoutMs: positiveInteger(raw['timeoutMs'], DEFAULT_TIMEOUT_MS),
        selector: typeof raw['selector'] === 'string' ? raw['selector'] : null,
        publicEndpoints: raw['publicEndpoints'] !== false,
        allowPrivateNetwork: Boolean(raw['allowPrivateNetwork']),
        allowThirdPartyReader: Boolean(raw['allowThirdPartyReader']),
        allowArchive: Boolean(raw['allowArchive']),
        interactive: Boolean(raw['interactive']),
        optionWarnings: raw['allowArchive'] ? ['archive-fallback-deferred'] : [],
    };
    if (typeof raw['query'] === 'string' && raw['query']) result.query = raw['query'];
    if (typeof raw['proxy'] === 'string' && raw['proxy']) result.proxy = raw['proxy'];
    return result;
}

export async function runAdaptiveFetch(input: Record<string, unknown>, deps: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const options = normalizeAdaptiveFetchOptions(input);
    const fetchImpl = (deps['fetch'] || input['fetchImpl']) as typeof fetch | undefined;
    const mergedDeps = fetchImpl ? { ...deps, fetch: fetchImpl } : deps;
    return executeAdaptiveFetch(options, mergedDeps) as unknown as Record<string, unknown>;
}

export async function runAdaptiveFetchCli(args: string[], deps: Record<string, unknown> = {}): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: false,
        options: {
            json: { type: 'boolean', default: false },
            trace: { type: 'boolean', default: false },
            browser: { type: 'string', default: 'auto' },
            'browser-session': { type: 'string' },
            identity: { type: 'string', default: 'auto' },
            'no-browser': { type: 'boolean', default: false },
            'max-bytes': { type: 'string' },
            'timeout-ms': { type: 'string' },
            selector: { type: 'string' },
            'no-public-endpoints': { type: 'boolean', default: false },
            'allow-third-party-reader': { type: 'boolean', default: true },
            'allow-archive': { type: 'boolean', default: false },
            query: { type: 'string' },
            proxy: { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help || positionals.length === 0) {
        console.log(formatAdaptiveFetchHelp());
        return;
    }
    const result = await runAdaptiveFetch({
        url: positionals[0],
        json: values.json,
        trace: values.trace,
        browser: values['no-browser'] ? 'never' : values.browser,
        browserSession: values['browser-session'],
        identity: values.identity,
        maxBytes: values['max-bytes'],
        timeoutMs: values['timeout-ms'],
        selector: values.selector,
        publicEndpoints: !values['no-public-endpoints'],
        allowThirdPartyReader: values['allow-third-party-reader'],
        allowArchive: values['allow-archive'],
        query: values['query'],
        proxy: values['proxy'],
    }, deps);
    if (values.json) {
        const { _traceSummary, ...jsonResult } = result;
        await writeStdoutLine(JSON.stringify(compactAdaptiveFetchResult(jsonResult), null, 2), deps['stdout'] as { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean } | undefined);
    } else {
        await writeStdoutLine(formatAdaptiveFetchHuman(result), deps['stdout'] as { write: (chunk: string, cb?: (error?: Error | null) => void) => boolean } | undefined);
    }
}

export function formatAdaptiveFetchHelp(): string {
    return `agbrowse fetch <url> [--json] [--trace] [--browser auto|never|required]
            [--browser-session none|isolated|existing|user|interactive]
            [--identity auto|minimal|chrome]

Read one URL through a 6-phase adaptive escalation ladder.
Not generic search — use search tools to find URLs first.

Options:
  --json                         Output JSON
  --trace                        Include attempt trace
  --browser auto|never|required  Browser escalation mode
  --no-browser                   Alias for --browser never
  --browser-session <mode>       Session mode:
      none       fresh cookie jar, no browser (HTTP phases)
      isolated   fresh Chrome profile, no cookies (browser phases)
      existing   reuse existing Chrome session
      user       user's authenticated browser session (explicit opt-in)
      interactive  user session + human-in-the-loop challenge resolution
  --identity auto|minimal|chrome Request identity headers
  --max-bytes N                  Maximum response bytes per read
  --timeout-ms N                 Per-attempt timeout
  --selector CSS                 Browser text extraction selector
  --allow-third-party-reader     Use Jina Reader as fallback (default: on)
  --no-allow-third-party-reader  Disable Jina Reader fallback
  --no-public-endpoints          Skip known public endpoint resolvers
  --allow-archive                Accepted but deferred; emits a warning
`;
}

export function formatAdaptiveFetchHuman(result: Record<string, unknown>): string {
    return [
        `ok: ${result['ok']}`,
        `verdict: ${result['verdict']}`,
        `source: ${result['source']}`,
        `final_url: ${result['finalUrl']}`,
        `browser: ${result['browserMode']}/${result['browserSession']} identity=${result['identity']}`,
        `summary: ${result['summary']}`,
    ].join('\n');
}

function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string, name: string): string {
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value);
    if (!allowed.has(text)) throw new Error(`invalid ${name}: ${text}`);
    return text;
}

function positiveInteger(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
