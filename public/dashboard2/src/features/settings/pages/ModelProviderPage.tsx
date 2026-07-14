import type { JSX } from 'react';
import { SettingsPageShell } from '../SettingsPageShell.tsx';
import type { SettingsPageProps } from '../settings-types.ts';

export function ModelProviderPage({ port, dirty }: SettingsPageProps): JSX.Element {
    return <SettingsPageShell title="Model providers" description="Select a provider and configure its credentials." source="instance" port={port} dirty={dirty} fields={[
        { key: 'provider', label: 'Provider', kind: 'select', options: [{ label: 'OpenAI', value: 'openai' }, { label: 'Anthropic', value: 'anthropic' }, { label: 'Google', value: 'google' }, { label: 'OpenRouter', value: 'openrouter' }] },
        { key: 'apiKeys.openai', label: 'OpenAI API key', kind: 'secret', placeholder: 'sk-…' },
        { key: 'apiKeys.anthropic', label: 'Anthropic API key', kind: 'secret', placeholder: 'sk-ant-…' },
        { key: 'providerBaseUrl', label: 'Custom base URL', description: 'Optional OpenAI-compatible endpoint.', kind: 'text', placeholder: 'https://api.example.com/v1' },
    ]} />;
}
