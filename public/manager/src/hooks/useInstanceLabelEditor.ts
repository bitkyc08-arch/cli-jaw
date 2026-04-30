import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
    DashboardRegistryLoadResult,
    DashboardRegistryPatch,
    DashboardScanResult,
} from '../types';

type SaveRegistry = (patch: DashboardRegistryPatch) => Promise<DashboardRegistryLoadResult | null>;

export function useInstanceLabelEditor(
    saveRegistry: SaveRegistry,
    setData: Dispatch<SetStateAction<DashboardScanResult | null>>,
) {
    const [error, setError] = useState<string | null>(null);

    const saveInstanceLabel = useCallback(async (port: number, label: string | null): Promise<void> => {
        const nextLabel = label?.trim() || null;
        const result = await saveRegistry({ instances: { [String(port)]: { label: nextLabel } } });
        if (!result) {
            const message = 'instance label save failed';
            setError(message);
            throw new Error(message);
        }
        setError(null);
        setData(current => current ? {
            ...current,
            instances: current.instances.map(instance => instance.port === port
                ? { ...instance, label: nextLabel }
                : instance),
        } : current);
    }, [saveRegistry, setData]);

    return { error, saveInstanceLabel };
}
