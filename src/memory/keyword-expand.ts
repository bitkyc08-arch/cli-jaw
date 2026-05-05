import fs from 'fs';
import { createSign } from 'crypto';
import { sanitizeKeywords } from './shared.js';

type AdvancedConfig = {
    enabled?: boolean;
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    vertexConfig?: string;
    bootstrap?: {
        enabled?: boolean;
        useActiveCli?: boolean;
        cli?: string;
        model?: string;
    };
};

type VertexConfig = {
    endpoint?: string;
    token?: string;
    model?: string;
    project_id?: string;
    projectId?: string;
    location?: string;
    credentials_path?: string;
    credentialsPath?: string;
    credentials_json?: Record<string, any>;
    credentialsJson?: Record<string, any>;
};

let lastExpansionTerms: string[] = [];

export function getLastExpansionTerms() {
    return lastExpansionTerms;
}

export function normalizeOpenAiCompatibleBaseUrl(raw: string) {
    const value = String(raw || '').trim();
    if (!value) return '';
    const trimmed = value.replace(/\/+$/, '');
    return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function getAdvancedConfig(override: Partial<AdvancedConfig> = {}) {
    return {
        enabled: true,
        provider: override.provider ?? 'integrated',
        model: override.model ?? '',
        apiKey: override.apiKey ?? '',
        baseUrl: normalizeOpenAiCompatibleBaseUrl(override.baseUrl ?? ''),
        vertexConfig: override.vertexConfig ?? '',
        bootstrap: {
            enabled: override.bootstrap?.enabled ?? true,
            useActiveCli: override.bootstrap?.useActiveCli ?? true,
            cli: override.bootstrap?.cli ?? '',
            model: override.bootstrap?.model ?? '',
        },
    };
}

function heuristicKeywords(query: string) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokens = q.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
    const out = new Set<string>([q, ...tokens]);
    const lower = q.toLowerCase();
    if (/login|로그인|auth|인증/.test(lower)) {
        out.add('login');
        out.add('auth');
        out.add('인증');
        out.add('401');
    }
    if (/launchd|service|plist|시작 안됨/.test(lower)) {
        out.add('launchd');
        out.add('plist');
        out.add('service');
    }
    return [...out].slice(0, 5);
}

function extractJsonArray(text: string) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        return sanitizeKeywords(parsed);
    } catch {
        const match = trimmed.match(/\[[\s\S]*\]/);
        if (match) {
            try {
                return sanitizeKeywords(JSON.parse(match[0]));
            } catch {
                return [];
            }
        }
        return [];
    }
}

async function expandViaGemini(query: string, override: Partial<AdvancedConfig> = {}) {
    const cfg = getAdvancedConfig(override);
    const apiKey = cfg.apiKey || process.env.GEMINI_API_KEY || '';
    const model = cfg.model || 'gemini-3.1-flash-lite-preview';
    if (!apiKey) return [];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
        contents: [{
            parts: [{
                text: `사용자 질문을 바탕으로 로컬 마크다운 기억을 뒤질 검색 키워드 5개를 JSON 배열로만 출력해라.
- 한국어, 영어, 동의어, 에러코드, 모듈명 포함 가능
- 예: ["로그인","login","auth","401","인증"]

질문: ${query}`,
            }],
        }],
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('\n') || '';
    return extractJsonArray(text);
}

async function expandViaOpenAiCompatible(query: string, override: Partial<AdvancedConfig> = {}) {
    const cfg = getAdvancedConfig(override);
    const apiKey = cfg.apiKey || '';
    const baseUrl = cfg.baseUrl || '';
    const model = cfg.model || 'gpt-4o-mini';
    if (!apiKey || !baseUrl) return [];
    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: 'Return only valid JSON: {"keywords":["k1","k2","k3"]}',
                },
                {
                    role: 'user',
                    content: `Expand this user query into up to 5 search keywords for local markdown search. Include Korean, English, synonyms, error codes, module names when helpful.\nQuery: ${query}`,
                },
            ],
        }),
    });
    if (!res.ok) return [];
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = json?.choices?.[0]?.message?.content || '';
    try {
        const parsed = JSON.parse(text);
        return sanitizeKeywords(parsed.keywords);
    } catch {
        return extractJsonArray(text);
    }
}

function loadServiceAccount(config: VertexConfig) {
    if (config.credentials_json || config.credentialsJson) return config.credentials_json || config.credentialsJson;
    const path = config.credentials_path || config.credentialsPath || '';
    if (!path) return null;
    try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

interface ServiceAccountKey {
    client_email: string;
    private_key: string;
    token_uri: string;
}

async function getGoogleAccessToken(sa: ServiceAccountKey) {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600;
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim = Buffer.from(JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: sa.token_uri,
        exp,
        iat,
    })).toString('base64url');
    const unsigned = `${header}.${claim}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(sa.private_key).toString('base64url');
    const assertion = `${unsigned}.${signature}`;

    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
    });
    const res = await fetch(sa.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) return '';
    const json = await res.json() as { access_token?: string };
    return json?.access_token || '';
}

async function expandViaVertex(query: string, override: Partial<AdvancedConfig> = {}) {
    const cfgSetting = getAdvancedConfig(override);
    const cfgRaw = cfgSetting.vertexConfig || '';
    if (!cfgRaw) return [];
    let cfg: VertexConfig;
    try { cfg = JSON.parse(cfgRaw); } catch { return []; }

    let endpoint = cfg.endpoint || '';
    let token = cfg.token || '';
    const model = cfgSetting.model || cfg.model || 'gemini-3.1-flash-lite-preview';

    if (!endpoint) {
        const sa = loadServiceAccount(cfg);
        const project = cfg.project_id || cfg.projectId || sa?.project_id;
        const location = cfg.location || 'us-central1';
        if (sa && !token) token = await getGoogleAccessToken(sa);
        if (project) {
            endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
        }
    }
    if (!endpoint || !token) return [];

    const body = {
        contents: [{
            role: 'user',
            parts: [{
                text: `Return only a JSON array of up to 5 search keywords for local markdown search. Include Korean, English, synonyms, error codes, module names when useful.\nQuery: ${query}`,
            }],
        }],
    };
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('\n') || '';
    return extractJsonArray(text);
}

export function expandSearchKeywords(query: string): { exact: string[]; expanded: string[] } {
    const base = String(query || '').trim();
    if (!base) return { exact: [], expanded: [] };
    const heuristic = heuristicKeywords(base);
    const expanded = sanitizeKeywords(heuristic.filter(term => term !== base));
    lastExpansionTerms = [base, ...expanded];
    return { exact: [base], expanded };
}

export async function validateAdvancedMemoryConfig(override: Partial<{ provider?: string; model?: string; apiKey?: string; baseUrl?: string; vertexConfig?: string }> = {}) {
    const cfg = getAdvancedConfig(override);
    return { ok: true, provider: cfg.provider || 'integrated', error: '' };
}
