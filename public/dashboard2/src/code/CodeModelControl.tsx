import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { ModelPicker, type ModelPickerOption } from '../models/ModelPicker.tsx';
import {
    CodeApiError,
    type CodeApiClient,
    type CodeApiErrorCode,
    type CodeModelOptions,
} from './code-api-client.ts';

export interface CodeModelControlProps {
    client: CodeApiClient;
    sessionId: string | null;
    confirmedModelId?: string | null;
    onSelectionChange(modelId: string | null): void;
}

interface CodeModelControlError {
    code: CodeApiErrorCode;
    message: string;
}

export function providerQualifiedModel(provider: string, model: string): string {
    return `${provider}/${model}`;
}

function pickerOptions(catalog: CodeModelOptions | null, confirmedModelId: string | null = null): ModelPickerOption[] {
    if (!catalog) return [];
    const options = catalog.providers.flatMap(provider => provider.models.map(model => ({
        id: providerQualifiedModel(provider.id, model),
        provider: provider.id,
        model,
        label: model,
        description: provider.id,
    })));
    if (confirmedModelId && !options.some(option => option.id === confirmedModelId)) {
        const slash = confirmedModelId.indexOf('/');
        const provider = slash > 0 ? confirmedModelId.slice(0, slash) : '';
        const model = slash > 0 ? confirmedModelId.slice(slash + 1) : confirmedModelId;
        options.unshift({
            id: confirmedModelId,
            provider,
            model,
            label: model,
            description: `${provider || 'unknown'} · current session model`,
        });
    }
    return options;
}

function initialSelection(
    catalog: CodeModelOptions,
    options: ModelPickerOption[],
    confirmedModelId: string | null,
    activeSession: boolean,
): ModelPickerOption | null {
    const confirmed = options.find(option => option.id === confirmedModelId) ?? null;
    if (confirmed || activeSession) return confirmed;
    return options.find(option => (
        option.provider === catalog.defaultProvider && option.model === catalog.defaultModel
    )) ?? options[0] ?? null;
}

function safeError(error: unknown, fallback: string): CodeModelControlError {
    if (error instanceof CodeApiError) return { code: error.code, message: error.message };
    return { code: 'request_failed', message: fallback };
}

export function CodeModelControl({
    client,
    sessionId,
    confirmedModelId = null,
    onSelectionChange,
}: CodeModelControlProps): JSX.Element {
    const [catalog, setCatalog] = useState<CodeModelOptions | null>(null);
    const [selected, setSelected] = useState<ModelPickerOption | null>(null);
    const [loading, setLoading] = useState(true);
    const [switching, setSwitching] = useState(false);
    const [error, setError] = useState<CodeModelControlError | null>(null);
    const onSelectionChangeRef = useRef(onSelectionChange);
    const confirmedModelIdRef = useRef(confirmedModelId);
    const loadGenerationRef = useRef(0);
    const switchGenerationRef = useRef(0);
    const switchAbortRef = useRef<AbortController | null>(null);
    onSelectionChangeRef.current = onSelectionChange;
    confirmedModelIdRef.current = confirmedModelId;

    const options = useMemo(() => pickerOptions(catalog, confirmedModelId), [catalog, confirmedModelId]);

    useEffect(() => {
        const generation = ++loadGenerationRef.current;
        const controller = new AbortController();
        setCatalog(null);
        setSelected(null);
        setLoading(true);
        setError(null);
        void client.listModelOptions({ signal: controller.signal }).then(nextCatalog => {
            if (controller.signal.aborted || generation !== loadGenerationRef.current) return;
            const nextOptions = pickerOptions(nextCatalog, confirmedModelIdRef.current);
            const nextSelection = initialSelection(nextCatalog, nextOptions, confirmedModelIdRef.current, sessionId !== null);
            setCatalog(nextCatalog);
            setSelected(nextSelection);
            setLoading(false);
            if (sessionId === null || nextSelection) onSelectionChangeRef.current(nextSelection?.id ?? null);
        }).catch((cause: unknown) => {
            if (controller.signal.aborted || generation !== loadGenerationRef.current) return;
            setLoading(false);
            setError(safeError(cause, 'Code model inventory request failed'));
        });
        return () => {
            controller.abort();
            loadGenerationRef.current += 1;
        };
    }, [client, sessionId]);

    useEffect(() => {
        switchGenerationRef.current += 1;
        switchAbortRef.current?.abort();
        switchAbortRef.current = null;
        setSwitching(false);
        setError(null);
    }, [client, sessionId]);

    useEffect(() => {
        if (!sessionId || switching) return;
        setSelected(options.find(option => option.id === confirmedModelId) ?? null);
    }, [sessionId, confirmedModelId, options, switching]);

    useEffect(() => () => switchAbortRef.current?.abort(), []);

    async function selectModel(next: ModelPickerOption): Promise<void> {
        if (next.id === selected?.id) return;
        setError(null);
        if (!sessionId) {
            setSelected(next);
            onSelectionChangeRef.current(next.id);
            return;
        }

        switchAbortRef.current?.abort();
        const controller = new AbortController();
        switchAbortRef.current = controller;
        const generation = ++switchGenerationRef.current;
        setSwitching(true);
        try {
            const session = await client.setSessionModel(sessionId, next.id, { signal: controller.signal });
            if (controller.signal.aborted || generation !== switchGenerationRef.current) return;
            const confirmed = options.find(option => option.id === session.modelId);
            if (!confirmed) {
                throw new CodeApiError('invalid_response', 'Code model switch returned an unknown model');
            }
            setSelected(confirmed);
            onSelectionChangeRef.current(confirmed.id);
        } catch (cause: unknown) {
            if (controller.signal.aborted || generation !== switchGenerationRef.current) return;
            setError(safeError(cause, 'Code model switch failed'));
        } finally {
            if (generation === switchGenerationRef.current) {
                setSwitching(false);
                switchAbortRef.current = null;
            }
        }
    }

    return (
        <div
            className="d2-code-model-control"
            data-testid="code-model-control"
            data-state={loading ? 'loading' : switching ? 'switching' : error ? 'error' : 'ready'}
        >
            <ModelPicker
                label={sessionId ? 'Active Code session provider and model' : 'Provider and model for new Code sessions'}
                value={selected}
                options={options}
                loading={loading}
                pending={switching}
                disabled={!loading && options.length === 0}
                placement={sessionId ? 'above' : 'below'}
                onSelect={(next) => { void selectModel(next); }}
            />
            {catalog?.degraded ? (
                <small className="d2-code-model-note" role="status">Using the available fallback model inventory.</small>
            ) : null}
            {error ? (
                <div className="d2-code-model-error" role="alert" data-error-code={error.code}>
                    {error.message}
                </div>
            ) : null}
        </div>
    );
}

export default CodeModelControl;
