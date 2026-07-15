import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function McpPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="MCP servers" description="Configure Model Context Protocol server discovery." source="instance" adapterId="unsupported" port={port} dirty={dirty} fields={[
        { key: 'enabled', label: 'Enable MCP', kind: 'toggle', unsupported: 'MCP settings are planned for 089.14.' },
        { key: 'configPath', label: 'Configuration path', description: 'Path to the MCP server registry.', kind: 'text', placeholder: '~/.config/mcp.json', unsupported: 'MCP settings are planned for 089.14.' },
        { key: 'autoStart', label: 'Start servers automatically', kind: 'toggle', unsupported: 'MCP settings are planned for 089.14.' },
        { key: 'connectTimeoutMs', label: 'Connection timeout', description: 'Maximum connection time in milliseconds.', kind: 'number', min: 100, max: 120000, step: 100, unsupported: 'MCP settings are planned for 089.14.' },
    ]} />;
}
