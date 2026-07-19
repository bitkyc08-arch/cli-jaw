import { useCallback, useEffect, useState } from 'react';
import type { DockClient } from './dock-client';
import type { CliRegistry } from './cli-registry';

type Props = {
    client: DockClient;
    active: boolean;
    registry: CliRegistry;
    modelMap: Record<string, string[]>;
    activeCli: string;
};

type FlushSettings = { cli?: string; model?: string };

export function FlushAgentSection({ client, active, registry, modelMap, activeCli }: Props) {
    const [open, setOpen] = useState(false);
    const [flushCli, setFlushCli] = useState('');
    const [flushModel, setFlushModel] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        client.get<FlushSettings>('/api/memory-files')
            .then((data) => {
                if (cancelled) return;
                setFlushCli(data.cli || '');
                setFlushModel(data.model || '');
            })
            .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
        return () => { cancelled = true; };
    }, [client, active]);

    const effectiveCli = flushCli || activeCli;
    const models = modelMap[effectiveCli] || [];

    const save = useCallback((nextCli: string, nextModel: string) => {
        setFlushCli(nextCli);
        setFlushModel(nextModel);
        setError(null);
        client.put('/api/memory-files/settings', { cli: nextCli, model: nextModel })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, [client]);

    const cliKeys = Object.keys(registry);
    const badgeParts: string[] = [];
    if (effectiveCli) badgeParts.push(`${registry[effectiveCli]?.label || effectiveCli}${flushCli ? '' : '*'}`);
    if (flushModel && flushModel !== 'default') badgeParts.push(flushModel);

    return (
        <div className="dock-section">
            <button type="button" className="dock-section-header" onClick={() => setOpen((prev) => !prev)}>
                <span>Flush Agent {badgeParts.length > 0 && <span className="dock-dim">({badgeParts.join(' / ')})</span>}</span>
                <span>{open ? '▾' : '▸'}</span>
            </button>
            {open && (
                <div className="dock-section-body">
                    <label className="dock-field">
                        <span>CLI</span>
                        <select value={flushCli} onChange={(event) => save(event.target.value, flushModel)}>
                            <option value="">(active CLI)</option>
                            {cliKeys.map((key) => <option key={key} value={key}>{registry[key]?.label || key}</option>)}
                        </select>
                    </label>
                    <label className="dock-field">
                        <span>모델</span>
                        <select value={flushModel} onChange={(event) => save(flushCli, event.target.value)}>
                            <option value="default">default</option>
                            {models.map((model) => <option key={model} value={model}>{model}</option>)}
                            {flushModel && flushModel !== 'default' && !models.includes(flushModel) && (
                                <option value={flushModel}>{flushModel}</option>
                            )}
                        </select>
                    </label>
                    {error && <div className="dock-error">{error}</div>}
                </div>
            )}
        </div>
    );
}
