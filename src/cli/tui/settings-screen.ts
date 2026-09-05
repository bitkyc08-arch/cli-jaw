import { visualWidth } from './renderers.js';
import { presentationMode } from '../../shared/presentation.js';

export type SettingsRowKind = 'editable' | 'readonly';
export type SettingsRowScope = 'cli' | 'web-ai' | 'runtime';

export interface SettingsRow {
    id: string;
    label: string;
    value: string;
    description: string;
    kind: SettingsRowKind;
    scope: SettingsRowScope;
}

export interface SettingsScreenState {
    selected: number;
    message?: string;
}

export interface SettingsScreenSnapshot {
    settings: Record<string, unknown>;
    tuiConfig: Record<string, unknown>;
    footerPreview: string;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeString(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ');
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
    return fallback;
}

function boolValue(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') return value;
    return fallback;
}

function numberValue(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeTheme(value: unknown): 'dark' | 'light' {
    return value === 'light' ? 'light' : 'dark';
}

function compactDensity(tui: Record<string, unknown>): string {
    const lines = numberValue(tui['pasteCollapseLines'], 2);
    const chars = numberValue(tui['pasteCollapseChars'], 160);
    if (lines <= 1 || chars <= 120) return 'compact';
    if (lines >= 4 || chars >= 260) return 'roomy';
    return 'normal';
}

export function buildAppearanceRows(snapshot: SettingsScreenSnapshot): SettingsRow[] {
    const settings = asRecord(snapshot.settings);
    const tui = { ...asRecord(settings['tui']), ...snapshot.tuiConfig };
    return [
        {
            id: 'theme',
            label: 'Theme',
            scope: 'cli',
            value: normalizeTheme(tui['theme']),
            description: 'Dark/light terminal token theme',
            kind: 'editable',
        },
        {
            id: 'fullscreenDefault',
            label: 'Fullscreen Default',
            scope: 'cli',
            value: boolValue(tui['fullscreen'], true) ? 'enabled' : 'disabled',
            description: 'Default jaw chat display mode',
            kind: 'editable',
        },
        {
            id: 'compactDensity',
            label: 'Compact Density',
            scope: 'cli',
            value: compactDensity(tui),
            description: 'Preset for pasted/long input collapse',
            kind: 'editable',
        },
        {
            id: 'pasteCollapseLines',
            label: 'Paste Collapse Lines',
            scope: 'cli',
            value: safeString(tui['pasteCollapseLines'], '2'),
            description: 'Lines before pasted input collapses',
            kind: 'editable',
        },
        {
            id: 'pasteCollapseChars',
            label: 'Paste Collapse Chars',
            scope: 'cli',
            value: safeString(tui['pasteCollapseChars'], '160'),
            description: 'Characters before pasted input collapses',
            kind: 'editable',
        },
        {
            id: 'keymapPreset',
            label: 'Keymap Preset',
            scope: 'cli',
            value: safeString(tui['keymapPreset'], 'default'),
            description: 'Keyboard interaction preset',
            kind: 'editable',
        },
        {
            id: 'diffStyle',
            label: 'Diff Style',
            scope: 'cli',
            value: safeString(tui['diffStyle'], 'summary'),
            description: 'Default diff rendering density',
            kind: 'editable',
        },
        {
            id: 'showReasoning',
            label: 'Reasoning Visibility',
            scope: 'web-ai',
            value: boolValue(settings['showReasoning']) ? 'on' : 'off',
            description: 'Web AI setting: show model reasoning/tool thinking when provided',
            kind: 'editable',
        },
        {
            id: 'presentation',
            label: 'Presentation',
            scope: 'runtime',
            value: presentationMode(settings),
            description: 'Activity (default) or legacy transcript',
            kind: 'editable',
        },
        {
            id: 'markdownRenderer',
            label: 'Markdown Renderer',
            scope: 'runtime',
            value: 'jawcode bridge (runtime)',
            description: 'Current renderer mode',
            kind: 'readonly',
        },
        {
            id: 'toolRows',
            label: 'Tool Rows',
            scope: 'runtime',
            value: 'folded by default (runtime)',
            description: 'Collapsed tool summary behavior',
            kind: 'readonly',
        },
        {
            id: 'composerPin',
            label: 'Composer Pin',
            scope: 'runtime',
            value: 'enabled (runtime)',
            description: 'Bottom composer cluster stays fixed',
            kind: 'readonly',
        },
    ];
}

function padVisible(text: string, width: number): string {
    return `${text}${' '.repeat(Math.max(0, width - visualWidth(text)))}`;
}

export function composeSettingsScreenLines(
    snapshot: SettingsScreenSnapshot,
    state: SettingsScreenState,
    options: {
        columns: number;
        height: number;
        cyanCode: string;
        dimCode: string;
        boldCode: string;
        resetCode: string;
        clipTextToCols: (text: string, cols: number) => string;
    },
): string[] {
    const rows = buildAppearanceRows(snapshot);
    const selected = Math.max(0, Math.min(state.selected, rows.length - 1));
    const lines: string[] = [
        `  ${options.cyanCode}${options.boldCode}Settings:${options.resetCode} cli-jaw`,
        `  ${options.dimCode}Only supported local CLI/TUI settings and real Web AI settings are shown.${options.resetCode}`,
        '',
        `  ${options.dimCode}Preview:${options.resetCode}`,
        `  ${snapshot.footerPreview}`,
        '',
    ];

    const scopeTitle = (scope: SettingsRowScope): string => {
        if (scope === 'cli') return 'Local CLI / TUI';
        if (scope === 'web-ai') return 'Web AI Settings';
        return 'Runtime Frame Behavior';
    };
    let currentScope: SettingsRowScope | null = null;
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        if (row.scope !== currentScope) {
            currentScope = row.scope;
            lines.push(`  ${options.dimCode}${scopeTitle(row.scope)}${options.resetCode}`);
        }
        const marker = i === selected ? '›' : ' ';
        const label = padVisible(row.label, 28);
        const value = padVisible(row.value, 18);
        const detail = row.kind === 'readonly' ? `${options.dimCode}${row.description}${options.resetCode}` : options.dimCode + row.description + options.resetCode;
        const body = `${marker} ${label}${value}${detail}`;
        const styled = i === selected
            ? `${options.cyanCode}${options.boldCode}${body}${options.resetCode}`
            : row.kind === 'readonly' ? `${options.dimCode}${body}${options.resetCode}` : body;
        lines.push(`  ${styled}`);
    }

    lines.push('');
    if (state.message) lines.push(`  ${options.dimCode}${state.message.replace(/\s+/g, ' ')}${options.resetCode}`);
    lines.push(`  ${options.dimCode}(${selected + 1}/${rows.length}) · Enter/Space to change · ↑/↓ to move · Esc to return${options.resetCode}`);

    const safe = lines.map(line => options.clipTextToCols(line.replace(/\n/g, ' '), options.columns));
    return [
        ...safe.slice(0, options.height),
        ...new Array(Math.max(0, options.height - safe.length)).fill(''),
    ];
}

export function nextAppearancePatch(row: SettingsRow, snapshot: SettingsScreenSnapshot): Record<string, unknown> | null {
    if (row.kind === 'readonly') return null;
    const settings = asRecord(snapshot.settings);
    const tui = { ...asRecord(settings['tui']), ...snapshot.tuiConfig };
    switch (row.id) {
        case 'presentation':
            return { presentation: { mode: presentationMode(settings) === 'activity' ? 'legacy' : 'activity' } };
        case 'theme': {
            const next = normalizeTheme(tui['theme']) === 'dark' ? 'light' : 'dark';
            return { tui: { theme: next } };
        }
        case 'fullscreenDefault':
            return { tui: { fullscreen: !boolValue(tui['fullscreen'], true) } };
        case 'showReasoning':
            return { showReasoning: !boolValue(settings['showReasoning']) };
        case 'compactDensity': {
            const current = compactDensity(tui);
            if (current === 'compact') return { tui: { pasteCollapseLines: 2, pasteCollapseChars: 160 } };
            if (current === 'normal') return { tui: { pasteCollapseLines: 4, pasteCollapseChars: 260 } };
            return { tui: { pasteCollapseLines: 1, pasteCollapseChars: 120 } };
        }
        case 'pasteCollapseLines': {
            const current = numberValue(tui['pasteCollapseLines'], 2);
            const next = current <= 1 ? 2 : current <= 2 ? 4 : 1;
            return { tui: { pasteCollapseLines: next } };
        }
        case 'pasteCollapseChars': {
            const current = numberValue(tui['pasteCollapseChars'], 160);
            const next = current <= 120 ? 160 : current <= 160 ? 260 : 120;
            return { tui: { pasteCollapseChars: next } };
        }
        case 'keymapPreset': {
            const next = tui['keymapPreset'] === 'vim' ? 'default' : 'vim';
            return { tui: { keymapPreset: next } };
        }
        case 'diffStyle': {
            const next = tui['diffStyle'] === 'full' ? 'summary' : 'full';
            return { tui: { diffStyle: next } };
        }
        default:
            return null;
    }
}
