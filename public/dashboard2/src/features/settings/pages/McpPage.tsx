import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function McpPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="MCP servers" description="Configure Model Context Protocol server discovery." source="instance" slice="mcp" port={port} dirty={dirty} fields={[
        { key: 'enabled', label: 'Enable MCP', kind: 'toggle' },
        { key: 'configPath', label: 'Configuration path', description: 'Path to the MCP server registry.', kind: 'text', placeholder: '~/.config/mcp.json' },
        { key: 'autoStart', label: 'Start servers automatically', kind: 'toggle' },
        { key: 'connectTimeoutMs', label: 'Connection timeout', description: 'Maximum connection time in milliseconds.', kind: 'number', min: 100, max: 120000, step: 100 },
    ]} />;
}
