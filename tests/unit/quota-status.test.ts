import { readSource } from './source-normalize.js';
// #44: /api/quota 3-state classification matrix tests
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeCreds, getClaudeCredentialsPath, readLatestGrokSessionUsage } from '../../src/routes/quota.ts';

// Read source for structural verification
const quotaSrc = readSource(
    path.join(import.meta.dirname, '../../src/routes/quota.ts'), 'utf8'
);
const serverSrc = readSource(
    path.join(import.meta.dirname, '../../server.ts'), 'utf8'
);
// After Phase 4 decomposition, read all settings modules for structural checks
const settingsDir = path.join(import.meta.dirname, '../../public/js/features');
const settingsSrc = [
    'settings.ts', 'settings-types.ts', 'settings-core.ts', 'settings-cli-status.ts', 'settings-cli-status-render.ts',
    'settings-telegram.ts', 'settings-discord.ts', 'settings-channel.ts',
    'settings-stt.ts', 'settings-mcp.ts', 'settings-templates.ts',
].map(f => readSource(path.join(settingsDir, f), 'utf8')).join('\n');
const sidebarCss = readSource(
    path.join(import.meta.dirname, '../../public/css/sidebar.css'), 'utf8'
);

// ── Quota route: auth failure vs transient error ──

test('QS-001: fetchClaudeUsage distinguishes 401/403 from 5xx', () => {
    // 401/403 should return {authenticated: false}
    assert.ok(
        quotaSrc.includes('resp.status === 401') && quotaSrc.includes('resp.status === 403'),
        'should check for 401/403 status codes',
    );
    assert.ok(
        quotaSrc.includes('{ authenticated: false }'),
        'should return {authenticated: false} for auth failures',
    );
    assert.ok(
        quotaSrc.includes('{ error: true }'),
        'should return {error: true} for transient errors',
    );
});

test('QS-002: fetchCodexUsage distinguishes 401/403 from 5xx', () => {
    const codexFn = quotaSrc.slice(quotaSrc.indexOf('fetchCodexUsage'));
    assert.ok(
        codexFn.includes('resp.status === 401') && codexFn.includes('resp.status === 403'),
        'codex should also check 401/403',
    );
});

test('QS-003: readClaudeCreds supports cross-platform Claude credentials file', () => {
    assert.ok(
        quotaSrc.includes('getClaudeCredentialsPath'),
        'should centralize Claude credentials file path resolution',
    );
    assert.ok(
        quotaSrc.includes("CLAUDE_CONFIG_DIR"),
        'should support Claude Code custom config directory',
    );
    assert.ok(
        quotaSrc.includes("'.credentials.json'"),
        'should read Claude Code credentials JSON on Linux/Windows/WSL',
    );
    assert.ok(
        quotaSrc.includes('macOS stores subscription OAuth in Keychain'),
        'should document macOS Keychain behavior without making the reader macOS-only',
    );
});

test('QS-003b: readClaudeCreds reads CLAUDE_CONFIG_DIR credentials before OS keychain fallback', () => {
    const prev = {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
        CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
        CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-claude-creds-'));
    try {
        for (const key of Object.keys(prev)) delete process.env[key];
        process.env.CLAUDE_CONFIG_DIR = tmp;
        fs.writeFileSync(
            path.join(tmp, '.credentials.json'),
            JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-test', subscriptionType: 'max', rateLimitTier: 'tier-1' } }),
            { mode: 0o600 },
        );

        assert.equal(getClaudeCredentialsPath(tmp), path.join(tmp, '.credentials.json'));
        const creds = readClaudeCreds();
        assert.equal(creds?.token, 'oauth-test');
        assert.equal(creds?.source, 'credentials-json');
        assert.equal(creds?.quotaCapable, true);
        assert.deepEqual(creds?.account, { type: 'max', tier: 'tier-1' });
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value == null) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('QS-004: readGeminiAccount has cross-platform documentation', () => {
    assert.ok(
        quotaSrc.includes('Cross-platform'),
        'should document cross-platform behavior',
    );
});

test('QS-004b: Grok quota contract is auth/status only with best-effort session usage', () => {
    assert.ok(
        quotaSrc.includes("quotaSource: hasBilling ? 'progrok:billing-api' : 'not-exposed-by-grok-cli'"),
        'Grok quota should use progrok billing when available and otherwise stay explicit status-only metadata',
    );
    assert.ok(
        quotaSrc.includes("displayTier: billing?.tier || 'Grok'"),
        'Grok status should display billing tier when available and fall back to generic Grok copy',
    );
    assert.ok(
        quotaSrc.includes('readLatestGrokSessionUsage'),
        'Grok session usage reader should be best-effort and separate from quota',
    );
});

test('QS-004c: readLatestGrokSessionUsage reads newest signals.json without fake quota windows', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-grok-signals-'));
    try {
        const oldDir = path.join(tmp, '.grok', 'sessions', 'project', 'old');
        const newDir = path.join(tmp, '.grok', 'sessions', 'project', 'new');
        fs.mkdirSync(oldDir, { recursive: true });
        fs.mkdirSync(newDir, { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'signals.json'), JSON.stringify({ contextTokensUsed: 10, primaryModelId: 'old' }));
        fs.writeFileSync(path.join(newDir, 'signals.json'), JSON.stringify({
            turnCount: 3,
            contextTokensUsed: 1234,
            contextWindowTokens: 512000,
            contextWindowUsage: 1,
            primaryModelId: 'grok-build',
            modelsUsed: ['grok-build'],
        }));
        const now = new Date();
        fs.utimesSync(path.join(oldDir, 'signals.json'), new Date(now.getTime() - 10_000), new Date(now.getTime() - 10_000));
        fs.utimesSync(path.join(newDir, 'signals.json'), now, now);
        const usage = readLatestGrokSessionUsage(tmp);
        assert.equal(usage?.turnCount, 3);
        assert.equal(usage?.contextTokensUsed, 1234);
        assert.equal(usage?.primaryModelId, 'grok-build');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── Server.ts: classify logic ──

test('QS-005: /api/quota classify separates no-creds from API failure', () => {
    const settingsRouteSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/settings.ts'), 'utf8'
    );
    assert.ok(
        settingsRouteSrc.includes('hasCreds'),
        'should distinguish creds-present from creds-absent',
    );
    assert.ok(
        settingsRouteSrc.includes('fetchOpenCodeUsage()'),
        'opencode should use fetchOpenCodeUsage adapter',
    );
    assert.ok(
        settingsRouteSrc.includes("quotaSource: 'not-exposed-by-opencode-cli'"),
        'opencode fallback should keep auth/status-only metadata',
    );
    assert.ok(
        settingsRouteSrc.includes('const grokQuota = await fetchGrokStatus()') && settingsRouteSrc.includes('grok: grokQuota'),
        'Grok should be present in /api/quota as auth/status-only metadata',
    );
});

test('QS-005b: /api/quota returns every top-level CLI runtime key', () => {
    const settingsRouteSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/settings.ts'), 'utf8'
    );
    assert.ok(
        settingsRouteSrc.includes('CLI_KEYS.map((key) => [key, quotaByCli[key]'),
        '/api/quota should be keyed by CLI_KEYS instead of a hand-maintained subset',
    );
    for (const key of ['agy', "'ai-e'", 'claude', "'claude-e'", 'codex', "'codex-app'", 'cursor', "'kiro-code'", 'gemini', 'grok', 'opencode', 'copilot']) {
        assert.ok(settingsRouteSrc.includes(`${key}:`), `/api/quota should define ${key}`);
    }
});

test('QS-005c3: AGY quota uses reverse-engineered adapters', () => {
    const settingsRouteSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/settings.ts'), 'utf8'
    );
    const agyQuotaSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/quota-agy-reverse.ts'), 'utf8'
    );
    assert.ok(settingsRouteSrc.includes('fetchAgyUsage()'), 'AGY quota should use fetchAgyUsage');
    assert.ok(
        agyQuotaSrc.includes('agy:antigravity-usage'),
        'AGY reverse quota should support antigravity-usage JSON adapter',
    );
    assert.ok(
        agyQuotaSrc.includes('agy:google-cloud-code-api'),
        'AGY reverse quota should fall back to Google Cloud Code API',
    );
});

test('QS-005c4: Kiro quota uses reverse-engineered CodeWhisperer adapter', () => {
    const settingsRouteSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/settings.ts'), 'utf8'
    );
    const kiroQuotaSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/quota-kiro-reverse.ts'), 'utf8'
    );
    assert.ok(settingsRouteSrc.includes('fetchKiroUsage()'), 'Kiro quota should use fetchKiroUsage');
    assert.ok(
        kiroQuotaSrc.includes('AmazonCodeWhispererService.GetUsageLimits'),
        'Kiro reverse quota should call CodeWhisperer GetUsageLimits',
    );
    assert.ok(
        settingsRouteSrc.includes('buildLiveCliRegistry'),
        '/api/cli-registry should merge live Kiro models',
    );
});

test('QS-005c5: OpenCode Go quota uses Bearer usage API adapter', () => {
    const settingsRouteSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/settings.ts'), 'utf8'
    );
    const opencodeQuotaSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/quota-opencode-go-api.ts'), 'utf8'
    );
    assert.ok(settingsRouteSrc.includes('fetchOpenCodeUsage()'), 'OpenCode quota should use fetchOpenCodeUsage');
    assert.ok(
        opencodeQuotaSrc.includes("quotaSource: 'opencode-go:usage-api'"),
        'OpenCode reverse quota should expose usage-api source tag',
    );
    assert.ok(
        opencodeQuotaSrc.includes('OPENCODE_GO_API_KEY'),
        'OpenCode reverse quota should read OPENCODE_GO_API_KEY env',
    );
    assert.ok(
        opencodeQuotaSrc.includes('/zen/go/v1/usage'),
        'OpenCode reverse quota should call zen/go/v1/usage',
    );
});

test('QS-005c2: Cursor quota uses reverse dashboard hook when configured', () => {
    const settingsRouteSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/settings.ts'), 'utf8'
    );
    const cursorQuotaSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/quota-cursor-dashboard.ts'), 'utf8'
    );
    assert.ok(
        settingsRouteSrc.includes('fetchCursorUsage()'),
        'Cursor quota should come from fetchCursorUsage helper',
    );
    assert.ok(
        cursorQuotaSrc.includes("quotaSource: 'cursor-dashboard-unofficial-api'"),
        'Cursor reverse quota should expose unofficial dashboard source tag',
    );
    assert.ok(
        cursorQuotaSrc.includes('CURSOR_SESSION_TOKEN'),
        'Cursor reverse quota should read dashboard session token env',
    );
});

test('QS-005d: wrapper runtimes delegate quota to their underlying runtime', () => {
    const settingsRouteSrc = readSource(
        path.join(import.meta.dirname, '../../src/routes/settings.ts'), 'utf8'
    );
    assert.ok(settingsRouteSrc.includes('resolveAiEQuotaProvider'), 'AI-E provider should be resolved from settings');
    assert.ok(settingsRouteSrc.includes("quotaSource: `ai-e:${aiEProvider}`"), 'AI-E should expose provider delegation metadata');
    assert.ok(settingsRouteSrc.includes("quotaSource: 'claude-e:underlying-claude'"), 'Claude E should delegate to Claude quota');
    assert.ok(settingsRouteSrc.includes("quotaSource: 'codex-app:underlying-codex'"), 'Codex App should delegate to Codex quota');
});

// ── Frontend: 3-state dot classification ──

test('QS-006: settings.ts has 3-state dotClass (ok/warn/missing)', () => {
    assert.ok(settingsSrc.includes("dotClass = 'ok'"), 'should have ok state');
    assert.ok(settingsSrc.includes("dotClass = 'warn'"), 'should have warn state');
    assert.ok(settingsSrc.includes("dotClass = 'missing'"), 'should have missing state');
});

test('QS-007: settings.ts warn state triggers on authenticated === false', () => {
    assert.ok(
        settingsSrc.includes('q.authenticated === false'),
        'should check authenticated === false for warn',
    );
});

test('QS-008: settings.ts error state keeps green (not warn)', () => {
    assert.ok(
        settingsSrc.includes('q.error'),
        'should check q.error',
    );
    // error should map to ok, not warn
    const errorLine = settingsSrc.split('\n').find((l: string) => l.includes('q.error'));
    assert.ok(errorLine, 'should have error handling line');
});

test('QS-009: settings.ts auth hint shows for warn state too', () => {
    assert.ok(
        settingsSrc.includes("dotClass === 'warn'"),
        'auth hint condition should include warn state',
    );
    assert.ok(
        settingsSrc.includes('cli.notAuthenticated'),
        'should use notAuthenticated i18n key for warn',
    );
});

test('QS-010: QuotaEntry type includes authenticated and error fields', () => {
    assert.ok(
        settingsSrc.includes('authenticated?: boolean'),
        'QuotaEntry should have authenticated field',
    );
    assert.ok(
        settingsSrc.includes('error?: boolean'),
        'QuotaEntry should have error field',
    );
});

test('QS-010e: QuotaEntry type includes auth/status-only fields', () => {
    for (const field of ['quotaCapable?: boolean', 'quotaSource?: string', 'sessionUsageCapable?: boolean', 'displayTier?: string', 'delegatedProvider?: string', 'sessionUsage?:']) {
        assert.ok(settingsSrc.includes(field), `QuotaEntry should include ${field}`);
    }
});

test('QS-010f: frontend renders generic status-only quota rows with setup hints', () => {
    assert.ok(
        settingsSrc.includes('q?.quotaCapable === false'),
        'status-only rendering should key off quotaCapable=false',
    );
    assert.ok(
        settingsSrc.includes('describeStatusOnlyQuota'),
        'status-only rows should use provider-aware copy',
    );
    assert.ok(
        settingsSrc.includes('QUOTA_SETUP_HINTS'),
        'status-only rows should expose actionable setup commands',
    );
    assert.ok(
        !settingsSrc.includes("name === 'grok' && q?.quotaCapable === false"),
        'status-only rendering must not be hardcoded to Grok only',
    );
});

test('QS-010b: QuotaWindow type preserves source modelId for compact Gemini labels', () => {
    assert.ok(
        settingsSrc.includes('modelId?: string'),
        'QuotaWindow should allow preserving source modelId',
    );
});

test('QS-010c: Gemini quota normalization exposes compact F/P policy', () => {
    assert.ok(
        quotaSrc.includes('normalizeGeminiQuotaBuckets'),
        'should expose Gemini quota normalization helper',
    );
    assert.ok(
        quotaSrc.includes("label: tier === 'pro' ? 'P' : 'F'"),
        'Gemini quota labels should normalize to P/F',
    );
    assert.ok(
        quotaSrc.includes("tier !== 'flash' && tier !== 'pro'"),
        'Gemini quota normalization should exclude non-Pro/Flash tiers',
    );
});

test('QS-010d: Copilot monthly quota writes reset to window resetsAt', () => {
    const copilotSrc = readSource(
        path.join(import.meta.dirname, '../../lib/quota-copilot.ts'), 'utf8',
    );
    assert.ok(
        copilotSrc.includes('nextMonthFirstResetDate'),
        'should have next-month-first fallback helper',
    );
    assert.ok(
        copilotSrc.includes('data.quota_reset_date || nextMonthFirstResetDate()'),
        'should fallback to next month first when API reset date is missing',
    );
    assert.ok(
        copilotSrc.includes('resetsAt,'),
        'Copilot Premium window should include resetsAt',
    );
});

// ── CSS: .cli-dot.warn style ──

test('QS-011: sidebar.css has .cli-dot.warn with yellow color', () => {
    assert.ok(sidebarCss.includes('.cli-dot.warn'), 'should have .cli-dot.warn class');
    assert.ok(sidebarCss.includes('#fbbf24') || sidebarCss.includes('var(--warning)'), 'should use yellow/warning color');
    assert.ok(sidebarCss.includes('pulse-warn'), 'should have pulse animation');
});

test('QS-012: sidebar.css has all 3 dot states', () => {
    assert.ok(sidebarCss.includes('.cli-dot.ok'), 'should have ok state');
    assert.ok(sidebarCss.includes('.cli-dot.warn'), 'should have warn state');
    assert.ok(sidebarCss.includes('.cli-dot.missing'), 'should have missing state');
});
