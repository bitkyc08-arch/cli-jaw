import type { Page, Locator } from 'playwright-core';

const PLUS_BUTTON_SELECTORS = [
    '[data-testid="composer-plus-btn"]',
    'button[aria-label="파일 추가 및 기타"]',
    'button[aria-label*="파일 추가" i]',
    'button[aria-label*="Add" i][aria-haspopup="menu"]',
    'button[aria-label*="Attach" i][aria-haspopup="menu"]',
    'button[data-testid*="plus" i]',
];

const TOOL_ALIASES = new Map<string, string>([
    ['image', 'image'], ['images', 'image'], ['create-image', 'image'], ['image-create', 'image'], ['이미지', 'image'], ['이미지만들기', 'image'], ['이미지 만들기', 'image'],
    ['deep-research', 'deep-research'], ['research', 'deep-research'], ['deep', 'deep-research'], ['심층리서치', 'deep-research'], ['심층 리서치', 'deep-research'],
    ['web-search', 'web-search'], ['web', 'web-search'], ['search', 'web-search'], ['browse', 'web-search'], ['웹검색', 'web-search'], ['웹 검색', 'web-search'],
    ['agent', 'agent-mode'], ['agent-mode', 'agent-mode'], ['에이전트', 'agent-mode'], ['에이전트 모드', 'agent-mode'],
    ['todo', 'tasks'], ['tasks', 'tasks'], ['task', 'tasks'], ['할일', 'tasks'], ['할 일 만들기', 'tasks'],
]);

const TOOL_LABELS: Record<string, string[]> = {
    image: ['이미지 만들기', 'Create image'],
    'deep-research': ['심층 리서치', 'Deep research'],
    'web-search': ['웹 검색', 'Web search'],
    'agent-mode': ['에이전트 모드', 'Agent mode'],
    tasks: ['할 일 만들기', 'Create tasks', 'Tasks'],
};

const PLUGIN_LABELS: Record<string, string[]> = {
    canva: ['Canva'],
    context7: ['Context7'],
    figma: ['Figma'],
    github: ['GitHub'],
    gmail: ['Gmail'],
    'google-drive': ['Google 드라이브', 'Google Drive'],
    drive: ['Google 드라이브', 'Google Drive'],
    'google-contacts': ['Google 주소록', 'Google Contacts'],
    contacts: ['Google 주소록', 'Google Contacts'],
    'google-calendar': ['Google Calendar', 'Google 캘린더'],
    calendar: ['Google Calendar', 'Google 캘린더'],
    'openai-platform': ['OpenAI Platform'],
    supabase: ['Supabase'],
    vercel: ['Vercel'],
};

function normalizeList(input: unknown): string[] {
    if (Array.isArray(input)) return input.map(String);
    if (typeof input === 'string') return input.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
}

function normalizeToolName(name: string): string | null {
    const key = name.toLowerCase().trim();
    return TOOL_ALIASES.get(key) ?? null;
}

function normalizePluginName(name: string): string | null {
    const key = name.toLowerCase().trim();
    if (PLUGIN_LABELS[key]) return key;
    for (const [k, labels] of Object.entries(PLUGIN_LABELS)) {
        if (labels.some((l) => l.toLowerCase() === key)) return k;
    }
    return null;
}

function looksLikeImageGeneration(prompt: string): boolean {
    return /\b(generate|create|make|draw|design|render)\b.*\b(image|picture|photo|illustration|art|icon|logo|poster|banner)/i.test(prompt)
        || /\b(이미지|그림|사진|일러스트|포스터|배너|아이콘|로고)\b.*\b(만들|생성|그려)/i.test(prompt);
}

function looksLikeDeepResearch(prompt: string): boolean {
    return /\b(deep\s*research|in-depth|thorough|comprehensive)\b.*\b(research|analysis|report|study|investigation)/i.test(prompt)
        || /\b(심층|깊이|종합|철저)\b.*\b(리서치|분석|조사|연구|보고서)/i.test(prompt);
}

function looksLikeWebSearch(prompt: string): boolean {
    return /\b(search|find|look\s*up|google|browse|check)\b.*\b(web|online|internet|latest|current|recent|news)/i.test(prompt)
        || /\b(검색|찾|최신|현재|최근|뉴스|웹)\b/i.test(prompt);
}

export interface ToolResolutionInput {
    tools?: string | string[];
    tool?: string | string[];
    plugins?: string | string[];
    plugin?: string | string[];
    webSearch?: boolean;
    outputImage?: string;
    research?: string;
    autoTools?: boolean;
    prompt?: string;
    goal?: string;
    question?: string;
    context?: string;
    constraints?: string;
}

export function resolveChatGptComposerToolRequests(input: ToolResolutionInput = {}): {
    tools: string[];
    plugins: string[];
    reasons: string[];
} {
    const tools = new Set<string>();
    const plugins = new Set<string>();
    const reasons: string[] = [];
    for (const tool of normalizeList(input.tools || input.tool || [])) {
        const normalized = normalizeToolName(tool);
        if (normalized) tools.add(normalized);
    }
    for (const plugin of normalizeList(input.plugins || input.plugin || [])) {
        const normalized = normalizePluginName(plugin);
        if (normalized) plugins.add(normalized);
    }
    if (input.webSearch === true) {
        tools.add('web-search');
        reasons.push('flag:web-search');
    }
    if (input.outputImage !== undefined && input.outputImage !== null && input.outputImage !== '') {
        tools.add('image');
        reasons.push('flag:output-image');
    }
    if (input.research === 'deep') {
        tools.add('deep-research');
        reasons.push('flag:research-deep');
    }
    if (input.autoTools === true) {
        const prompt = [input.prompt, input.goal, input.question, input.context, input.constraints].filter(Boolean).join('\n').toLowerCase();
        if (looksLikeImageGeneration(prompt)) {
            tools.add('image');
            reasons.push('auto:image-intent');
        }
        if (looksLikeDeepResearch(prompt)) {
            tools.add('deep-research');
            reasons.push('auto:deep-research-intent');
        } else if (looksLikeWebSearch(prompt)) {
            tools.add('web-search');
            reasons.push('auto:web-search-intent');
        }
    }
    return { tools: [...tools], plugins: [...plugins], reasons };
}

async function findPlusButton(page: Page): Promise<Locator | null> {
    for (const sel of PLUS_BUTTON_SELECTORS) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) return btn;
    }
    return null;
}

async function findToolMenuItem(page: Page, toolKey: string): Promise<Locator | null> {
    const labels = TOOL_LABELS[toolKey];
    if (!labels) return null;
    for (const label of labels) {
        const item = page.locator(`[role="menuitem"]:has-text("${label}"), [role="option"]:has-text("${label}")`).first();
        if (await item.isVisible().catch(() => false)) return item;
    }
    return null;
}

async function findPluginMenuItem(page: Page, pluginKey: string): Promise<Locator | null> {
    const labels = PLUGIN_LABELS[pluginKey];
    if (!labels) return null;
    for (const label of labels) {
        const item = page.locator(`[role="menuitem"]:has-text("${label}"), [role="option"]:has-text("${label}")`).first();
        if (await item.isVisible().catch(() => false)) return item;
    }
    return null;
}

export async function selectChatGptComposerTools(page: Page, input: ToolResolutionInput = {}): Promise<{
    requestedTools: string[];
    requestedPlugins: string[];
    selectedTools: string[];
    selectedPlugins: string[];
    warnings: string[];
    usedFallbacks: string[];
    reasons: string[];
} | null> {
    const resolved = resolveChatGptComposerToolRequests(input);
    if (resolved.tools.length === 0 && resolved.plugins.length === 0) return null;

    const selectedTools: string[] = [];
    const selectedPlugins: string[] = [];
    const warnings: string[] = [];
    const usedFallbacks: string[] = [];

    const plusBtn = await findPlusButton(page);
    if (!plusBtn) {
        warnings.push('composer-plus-button-not-found');
        return {
            requestedTools: resolved.tools,
            requestedPlugins: resolved.plugins,
            selectedTools,
            selectedPlugins,
            warnings,
            usedFallbacks,
            reasons: resolved.reasons,
        };
    }

    await plusBtn.click();
    await page.waitForTimeout(500);

    for (const tool of resolved.tools) {
        const item = await findToolMenuItem(page, tool);
        if (item) {
            await item.click();
            selectedTools.push(tool);
            await page.waitForTimeout(300);
            const stillOpen = await findPlusButton(page);
            if (resolved.tools.indexOf(tool) < resolved.tools.length - 1 || resolved.plugins.length > 0) {
                if (!stillOpen || !(await page.locator('[role="menu"]').first().isVisible().catch(() => false))) {
                    const reopen = await findPlusButton(page);
                    if (reopen) {
                        await reopen.click();
                        await page.waitForTimeout(300);
                    }
                }
            }
        } else {
            warnings.push(`tool-not-found:${tool}`);
        }
    }

    for (const plugin of resolved.plugins) {
        const item = await findPluginMenuItem(page, plugin);
        if (item) {
            await item.click();
            selectedPlugins.push(plugin);
            await page.waitForTimeout(300);
        } else {
            warnings.push(`plugin-not-found:${plugin}`);
        }
    }

    await page.keyboard.press('Escape').catch(() => undefined);

    return {
        requestedTools: resolved.tools,
        requestedPlugins: resolved.plugins,
        selectedTools,
        selectedPlugins,
        warnings,
        usedFallbacks,
        reasons: resolved.reasons,
    };
}
