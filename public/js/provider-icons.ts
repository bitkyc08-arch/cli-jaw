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

export type ProviderSlug = 'claude' | 'openai' | 'gemini' | 'copilot' | 'codex' | 'opencode';

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
    // Aliases — codex and opencode use OpenAI branding
    codex:    { color: openaiSvg,  mono: openaiSvg,      label: 'Codex' },
    opencode: { color: openaiSvg,  mono: openaiSvg,      label: 'OpenCode' },
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
    else return '';

    const entry = PROVIDER_ICONS[key];
    return variant === 'mono' ? entry.mono : entry.color;
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
    else return slug;
    return PROVIDER_ICONS[key].label;
}
