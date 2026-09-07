import type { icon } from '../../../js/icons';
type IconName = Parameters<typeof icon>[0];

/** Category glyphs use cli-jaw's existing Lucide registry names. */
const SETTINGS_ICONS: Readonly<Record<string, IconName>> = {
    agent: 'robot', model: 'package', profile: 'user', display: 'palette',
    'channels-telegram': 'send', 'channels-discord': 'message', 'channels-slack': 'message',
    heartbeat: 'heartPulse', memory: 'brain', mcp: 'plug', speech: 'mic',
    prompts: 'file', browser: 'web', network: 'route', permissions: 'shield',
    'advanced-export': 'download', employees: 'people',
    'manager-display': 'monitor', 'manager-activity': 'heartPulse',
    'manager-developer': 'tool', 'manager-embedding': 'search',
    'telegram-hub': 'radio', 'dashboard-meta': 'unknown',
};
export function settingsIcon(id: string): IconName { return SETTINGS_ICONS[id] ?? 'settings'; }
