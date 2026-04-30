export const CONTEXT_PACKAGE_REFERENCE = {
    package: 'cli-jaw',
    version: '1.7.37-preview.20260427171130',
    license: 'MIT',
    note: 'Context packaging behavior is implemented locally by cli-jaw web-ai.',
} as const;

export const DEFAULT_MAX_FILE_SIZE_BYTES = 1_000_000;
export const DEFAULT_INLINE_CHAR_LIMIT = 50_000;
export const DEFAULT_BROWSER_INLINE_CHAR_BUDGET = 60_000;
export const DEFAULT_TOKEN_WARNING_RATIO = 0.85;

export const DEFAULT_MODEL_INPUT_BUDGETS = {
    chatgpt: {
        instant: 196_000,
        thinking: 196_000,
        pro: 196_000,
        default: 196_000,
    },
    gemini: {
        default: 200_000,
        deepThink: 200_000,
    },
} as const;

export const DEFAULT_EXCLUDES = [
    '.git/**',
    'node_modules/**',
    'dist/**',
    'build/**',
    '.next/**',
    'coverage/**',
    '.env',
    '.env.*',
    '**/*.pem',
    '**/*.key',
    '**/*token*',
    '**/*secret*',
] as const;
