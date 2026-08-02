// ── Provider Icons ──
// AI provider brand icons from lobehub/icons-static-svg.
// SVGs are downloaded locally for offline support and bundled via Vite ?raw.

import claudeSvg from '../assets/providers/claude-color.svg?raw';
import openaiSvg from '../assets/providers/openai.svg?raw';
import geminiSvg from '../assets/providers/gemini-color.svg?raw';
import antigravitySvg from '../assets/providers/antigravity-color.svg?raw';
import grokSvg from '../assets/providers/grok-color.svg?raw';
import copilotSvg from '../assets/providers/copilot-color.svg?raw';
import cursorSvg from '../assets/providers/cursor-color.svg?raw';
import kiroSvg from '../assets/providers/kiro-color.svg?raw';

// Mono variants for dark/light mode flexibility
import claudeMonoSvg from '../assets/providers/claude.svg?raw';
import geminiMonoSvg from '../assets/providers/gemini.svg?raw';
import antigravityMonoSvg from '../assets/providers/antigravity.svg?raw';
import grokMonoSvg from '../assets/providers/grok.svg?raw';
import copilotMonoSvg from '../assets/providers/copilot.svg?raw';
import cursorMonoSvg from '../assets/providers/cursor.svg?raw';
import kiroMonoSvg from '../assets/providers/kiro.svg?raw';

// Service icons (Discord, Telegram)
import discordSvg from '../assets/providers/discord.svg?raw';
import slackSvg from '../assets/providers/slack.svg?raw';
import telegramSvg from '../assets/providers/telegram.svg?raw';
import opencodeSvg from '../assets/providers/opencode.svg?raw';

export type ProviderSlug = 'ai-e' | 'claude' | 'openai' | 'gemini' | 'antigravity' | 'grok' | 'copilot' | 'cursor' | 'kiro-code' | 'codex' | 'codex-app' | 'opencode' | 'discord' | 'telegram' | 'slack';

interface ProviderIcon {
    color: string;
    mono: string;
    label: string;
}

const openaiColorSvg = openaiSvg.replace('fill="currentColor"', 'fill="#10A37F"');

const PROVIDER_ICONS: Record<ProviderSlug, ProviderIcon> = {
    'ai-e':    { color: openaiColorSvg, mono: openaiSvg, label: 'AI-E' },
    claude:   { color: claudeSvg,  mono: claudeMonoSvg,  label: 'Claude' },
    openai:   { color: openaiColorSvg, mono: openaiSvg,  label: 'OpenAI' },
    gemini:   { color: geminiSvg,  mono: geminiMonoSvg,   label: 'Gemini' },
    antigravity: { color: antigravitySvg, mono: antigravityMonoSvg, label: 'Antigravity' },
    grok:     { color: grokSvg,    mono: grokMonoSvg,     label: 'Grok' },
    copilot:  { color: copilotSvg, mono: copilotMonoSvg,  label: 'Copilot' },
    cursor:   { color: cursorSvg,  mono: cursorMonoSvg,   label: 'Cursor' },
    'kiro-code': { color: kiroSvg, mono: kiroMonoSvg, label: 'Kiro' },
    codex:    { color: openaiSvg, mono: openaiSvg,  label: 'Codex' },
    'codex-app': { color: openaiColorSvg, mono: openaiSvg, label: 'Codex App' },
    opencode: { color: opencodeSvg, mono: opencodeSvg,   label: 'OpenCode' },
    discord:  { color: discordSvg,  mono: discordSvg,    label: 'Discord' },
    telegram: { color: telegramSvg, mono: telegramSvg,   label: 'Telegram' },
    slack:    { color: slackSvg,    mono: slackSvg,      label: 'Slack' },
};

const PROVIDER_LABEL_ALIASES: Record<string, string> = {
    'claude-e': 'Claude E',
    'ai-e': 'AI-E',
    'claude-exec': 'Claude E',
    'jaw-claude-i': 'Claude E',
    'claude-i': 'Claude E',
    'agy': 'Antigravity',
    cursor: 'Cursor',
    'kiro-code': 'Kiro',
};

function resolveProviderSlug(slug: string): ProviderSlug | null {
    const normalized = slug.toLowerCase().replace(/[-_\s]/g, '');
    if (normalized === 'aie') return 'ai-e';
    if (normalized === 'claude' || normalized.startsWith('claude')) return 'claude';
    if (normalized === 'gemini' || normalized.startsWith('gemini')) return 'gemini';
    if (normalized === 'antigravity' || normalized === 'agy' || normalized === 'googleantigravity') return 'antigravity';
    if (normalized === 'grok' || normalized.startsWith('grok')) return 'grok';
    if (normalized.startsWith('copilot') || normalized === 'githubcopilot') return 'copilot';
    if (normalized === 'cursor' || normalized.startsWith('cursor')) return 'cursor';
    if (normalized === 'kirocode' || normalized === 'kiro') return 'kiro-code';
    if (normalized === 'codexapp' || normalized === 'codexappserver') return 'codex-app';
    if (normalized === 'codex') return 'codex';
    if (normalized === 'opencode') return 'opencode';
    if (normalized === 'openai' || normalized.startsWith('gpt') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) return 'openai';
    if (normalized === 'discord') return 'discord';
    if (normalized === 'telegram') return 'telegram';
    if (normalized === 'slack') return 'slack';
    return null;
}

/** Get a provider icon SVG string. Returns color variant by default. */
export function providerIcon(slug: string, variant: 'color' | 'mono' = 'color'): string {
    const key = resolveProviderSlug(slug);
    if (!key) return '';

    const entry = PROVIDER_ICONS[key];
    return variant === 'mono' ? entry.mono : entry.color;
}

/**
 * Hydrate all `<span data-provider="SLUG">` elements with provider SVG icons.
 * Call once after DOMContentLoaded.
 */
export function hydrateProviderIcons(root: Element = document.body): void {
    const els = root.querySelectorAll<HTMLElement>('[data-provider]');
    for (const el of els) {
        const slug = el.dataset['provider'] || '';
        const svg = providerIcon(slug);
        if (svg) {
            el.innerHTML = svg;
            el.classList.add('cli-provider-icon');
        }
    }
}

/** Get a provider's display label. */
export function providerLabel(slug: string): string {
    const alias = PROVIDER_LABEL_ALIASES[slug.toLowerCase()];
    if (alias) return alias;
    const key = resolveProviderSlug(slug);
    if (!key) return slug;
    return PROVIDER_ICONS[key].label;
}
