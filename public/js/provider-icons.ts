// ── Provider Icons ──
// AI provider brand icons from lobehub/icons-static-svg.
// SVGs are downloaded locally for offline support and bundled via Vite ?raw.

import claudeSvg from '../assets/providers/claude-color.svg?raw';
import openaiSvg from '../assets/providers/openai.svg?raw';
import geminiSvg from '../assets/providers/gemini-color.svg?raw';
import copilotSvg from '../assets/providers/copilot-color.svg?raw';

// Mono variants for dark/light mode flexibility
import claudeMonoSvg from '../assets/providers/claude.svg?raw';
import geminiMonoSvg from '../assets/providers/gemini.svg?raw';
import copilotMonoSvg from '../assets/providers/copilot.svg?raw';

// Service icons (Discord, Telegram)
import discordSvg from '../assets/providers/discord.svg?raw';
import telegramSvg from '../assets/providers/telegram.svg?raw';
import opencodeSvg from '../assets/providers/opencode.svg?raw';

export type ProviderSlug = 'claude' | 'openai' | 'gemini' | 'copilot' | 'codex' | 'opencode' | 'discord' | 'telegram';

interface ProviderIcon {
    color: string;
    mono: string;
    label: string;
}

const PROVIDER_ICONS: Record<ProviderSlug, ProviderIcon> = {
    claude:   { color: claudeSvg,  mono: claudeMonoSvg,  label: 'Claude' },
    openai:   { color: openaiSvg,  mono: openaiSvg,      label: 'OpenAI' },
    gemini:   { color: geminiSvg,  mono: geminiMonoSvg,   label: 'Gemini' },
    copilot:  { color: copilotSvg, mono: copilotMonoSvg,  label: 'GitHub Copilot' },
    codex:    { color: openaiSvg,  mono: openaiSvg,      label: 'Codex (OpenAI)' },
    opencode: { color: opencodeSvg, mono: opencodeSvg,   label: 'OpenCode' },
    discord:  { color: discordSvg,  mono: discordSvg,    label: 'Discord' },
    telegram: { color: telegramSvg, mono: telegramSvg,   label: 'Telegram' },
};

/** Get a provider icon SVG string. Returns color variant by default. */
export function providerIcon(slug: string, variant: 'color' | 'mono' = 'color'): string {
    const normalized = slug.toLowerCase().replace(/[-_\s]/g, '');
    // Handle aliases
    let key: ProviderSlug;
    if (normalized === 'claude' || normalized.startsWith('claude')) key = 'claude';
    else if (normalized === 'gemini' || normalized.startsWith('gemini')) key = 'gemini';
    else if (normalized.startsWith('copilot') || normalized === 'githubcopilot') key = 'copilot';
    else if (normalized === 'codex') key = 'codex';
    else if (normalized === 'opencode') key = 'opencode';
    else if (normalized === 'openai' || normalized.startsWith('gpt') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) key = 'openai';
    else if (normalized === 'discord') key = 'discord';
    else if (normalized === 'telegram') key = 'telegram';
    else return '';

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
    const normalized = slug.toLowerCase().replace(/[-_\s]/g, '');
    let key: ProviderSlug;
    if (normalized === 'claude' || normalized.startsWith('claude')) key = 'claude';
    else if (normalized === 'gemini' || normalized.startsWith('gemini')) key = 'gemini';
    else if (normalized.startsWith('copilot') || normalized === 'githubcopilot') key = 'copilot';
    else if (normalized === 'codex') key = 'codex';
    else if (normalized === 'opencode') key = 'opencode';
    else if (normalized === 'openai' || normalized.startsWith('gpt') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) key = 'openai';
    else if (normalized === 'discord') key = 'discord';
    else if (normalized === 'telegram') key = 'telegram';
    else return slug;
    return PROVIDER_ICONS[key].label;
}
