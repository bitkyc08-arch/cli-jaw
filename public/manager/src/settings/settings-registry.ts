import type { SettingsCategoryId, SettingsCategoryGroup, SettingsPageProps, SettingsScope } from './types';
import type { ComponentType } from 'react';
import type { DashboardLocale } from '../types';
import { DASHBOARD_SETTINGS_COPY } from '../dashboard-settings/DashboardSettingsSidebar';
type Entry = { id: SettingsCategoryId; scope: SettingsScope; group: SettingsCategoryGroup;
    label: string | ((locale: DashboardLocale) => string); requiresInstance?: boolean; hidden?: boolean; load: () => Promise<{ default: ComponentType<SettingsPageProps> }> };
export const SETTINGS_REGISTRY: readonly Entry[] = [
    { id:'agent', scope:'instance', group:'runtime', label:'Agent', load:()=>import('./pages/Agent') },
    { id:'model', scope:'instance', group:'runtime', label:'Model defaults', load:()=>import('./pages/ModelProvider') },
    { id:'profile', scope:'instance', group:'identity', label:'Profile', load:()=>import('./pages/Profile') },
    { id:'display', scope:'instance', group:'identity', label:'Display', load:()=>import('./pages/Display') },
    { id:'channels-telegram', scope:'instance', group:'channels', label:'Channels — Telegram', load:()=>import('./pages/ChannelsTelegram') },
    { id:'channels-discord', scope:'instance', group:'channels', label:'Channels — Discord', load:()=>import('./pages/ChannelsDiscord') },
    { id:'channels-slack', scope:'instance', group:'channels', label:'Channels — Slack', load:()=>import('./pages/ChannelsSlack') },
    { id:'heartbeat', scope:'instance', group:'automation', label:'Heartbeat & schedules', load:()=>import('./pages/Heartbeat') },
    { id:'memory', scope:'instance', group:'automation', label:'Memory', load:()=>import('./pages/Memory') },
    { id:'mcp', scope:'instance', group:'mcp', label:'MCP servers', load:()=>import('./pages/Mcp') },
    { id:'speech', scope:'instance', group:'integrations', label:'Speech & keys', load:()=>import('./pages/SpeechKeys') },
    { id:'prompts', scope:'instance', group:'integrations', label:'Prompts', load:()=>import('./pages/Prompts') },
    { id:'browser', scope:'instance', group:'integrations', label:'Browser / CDP', load:()=>import('./pages/Browser') },
    { id:'network', scope:'instance', group:'network-security', label:'Network', load:()=>import('./pages/Network') },
    { id:'permissions', scope:'instance', group:'network-security', label:'Permissions', load:()=>import('./pages/Permissions') },
    { id:'advanced-export', scope:'instance', group:'advanced', label:'Export / import', load:()=>import('./pages/AdvancedExport') },
    { id:'employees', scope:'instance', group:'automation', label:'Employees', hidden:true, load:()=>import('./pages/Employees') },
    { id:'manager-display', scope:'manager', group:'identity', label:locale=>DASHBOARD_SETTINGS_COPY[locale].sections.display.label, load:()=>import('./pages/manager/Display') },
    { id:'manager-activity', scope:'manager', group:'identity', label:locale=>DASHBOARD_SETTINGS_COPY[locale].sections.activity.label, load:()=>import('./pages/manager/Activity') },
    { id:'manager-developer', scope:'manager', group:'advanced', label:locale=>DASHBOARD_SETTINGS_COPY[locale].sections.developer.label, load:()=>import('./pages/manager/Developer') },
    { id:'manager-embedding', scope:'manager', group:'automation', label:locale=>DASHBOARD_SETTINGS_COPY[locale].sections.embedding.label, load:()=>import('./pages/manager/Embedding') },
    { id:'telegram-hub', scope:'manager', group:'channels', label:locale=>DASHBOARD_SETTINGS_COPY[locale].sections.telegramHub.label, load:()=>import('./pages/manager/TelegramHub') },
    { id:'dashboard-meta', scope:'manager', requiresInstance:true, group:'advanced', label:'Dashboard meta', load:()=>import('./pages/DashboardMeta') },
];
export const entriesForScopes = (scopes: readonly SettingsScope[], hasInstance: boolean, locale: DashboardLocale) =>
    SETTINGS_REGISTRY.filter(entry => !entry.hidden && scopes.includes(entry.scope)
        && (hasInstance || (entry.scope !== 'instance' && !entry.requiresInstance)))
        .map(entry => ({...entry, label:typeof entry.label==='function' ? entry.label(locale) : entry.label}));
