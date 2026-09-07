import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CodeControllerModel } from './code-controller-types';
import type { CodeCreateSessionRequest } from '../../../../src/code-mode/wire';
import { CODE_POLICY_DETAILS, CODE_POLICY_LABELS, CODE_RUNTIME_LABELS } from './code-types';

type MenuOption<T extends string> = { value: T; label: string; detail?: string | undefined; disabled?: boolean };
export function CodeFooterMenu<T extends string>({ label, value, options, disabled, onChange, displayValue }: {
    label: string; value: T; options: MenuOption<T>[]; disabled: boolean; onChange(value: T): void; displayValue?: string;
}) {
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ left: number; bottom: number | 'auto'; top?: number; width: number; maxHeight: number } | null>(null);
    const selected = options.find(option => option.value === value);
    function close(restore = true) { setPosition(null); if (restore) trigger.current?.focus(); }
    function open() {
        const rect = trigger.current?.getBoundingClientRect();
        if (!rect || disabled) return;
        const width = Math.min(340, window.innerWidth - 28);
        const above = Math.max(0, rect.top - 16);
        const below = Math.max(0, window.innerHeight - rect.bottom - 16);
        const common = { left: Math.max(14, Math.min(rect.left, window.innerWidth - width - 14)), width };
        setPosition(above >= below
            ? { ...common, bottom: window.innerHeight - rect.top + 8, maxHeight: Math.min(280, above) }
            : { ...common, bottom: 'auto', top: rect.bottom + 8, maxHeight: Math.min(280, below) });
    }
    useEffect(() => {
        if (!position) return;
        const buttons = menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        const selectedButton = [...(buttons ?? [])].find(button => button.getAttribute('aria-selected') === 'true');
        (selectedButton ?? buttons?.[0])?.focus();
        const outside = (event: PointerEvent) => {
            if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false);
        };
        const resize = () => close(false);
        document.addEventListener('pointerdown', outside);
        window.addEventListener('resize', resize);
        return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); };
    }, [position]);
    useEffect(() => { if (disabled) setPosition(null); }, [disabled]);
    function navigate(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (event.key === 'Tab') { event.preventDefault(); close(); return; }
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const current = buttons.findIndex(button => button === document.activeElement);
        let index: number;
        if (event.key === 'ArrowDown') index = (current + 1) % buttons.length;
        else if (event.key === 'ArrowUp') index = (current - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = buttons.length - 1;
        else return;
        event.preventDefault(); buttons[index]?.focus();
    }
    return <div className="code-footer-menu">
        <button ref={trigger} type="button" className="code-footer-menu-trigger" aria-label={label}
            aria-haspopup="listbox" aria-expanded={Boolean(position)} aria-controls={position ? id : undefined}
            disabled={disabled} title={selected?.detail} onClick={() => position ? close() : open()}
            onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } }}>
            <span className="code-footer-label">{label}</span><strong>{selected?.label ?? displayValue ?? (value || 'Not selected')}</strong>
        </button>
        {position && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} className="code-footer-dropup code-footer-floating"
            style={position} onKeyDown={navigate}>
            {options.map(option => <button type="button" role="option" aria-selected={option.value === value}
                key={option.value} disabled={option.disabled} className="code-footer-dropup-option"
                onClick={() => { onChange(option.value); close(); }}>
                <span><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
            </button>)}
        </div>, document.body)}
    </div>;
}

export function ComposerFooter({ controller: c }: { controller: CodeControllerModel }) {
    const selection = c.selection;
    const provider = c.catalog?.providers.find(entry => entry.id === selection.provider);
    const capabilities = c.session?.capabilities ?? provider?.capabilities;
    const locked = c.selectedId !== null;
    const disabled = c.pending || c.busy || c.creationUnknown || c.operation.kind !== 'idle' || (locked && (!c.synced || c.session?.status !== 'idle' || c.session?.archivedAt !== null));
    const [modelText, setModelText] = useState(selection.model);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const guard = useRef(false);
    const modelSuggestions = useId();
    useEffect(() => { setModelText(selection.model); }, [selection.model]);
    async function change(patch: Partial<CodeCreateSessionRequest>) {
        if (disabled || guard.current) return;
        guard.current = true; setSaving(true); setError(null);
        try { await c.setSelection(patch); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { guard.current = false; setSaving(false); }
    }
    const controlsDisabled = disabled || saving;
    const modelDisabled = controlsDisabled;
    return <>
        <div className="code-composer-footer">
            <CodeFooterMenu label="Runtime" value={selection.provider} disabled={locked ? !c.catalog : controlsDisabled || !c.catalog}
                options={(Object.keys(CODE_RUNTIME_LABELS) as Array<keyof typeof CODE_RUNTIME_LABELS>).map(id => {
                    const entry = c.catalog?.providers.find(p => p.id === id);
                    return { value: id, label: locked && id !== selection.provider ? `New ${CODE_RUNTIME_LABELS[id]} session` : CODE_RUNTIME_LABELS[id],
                        disabled: !entry?.available || (locked && id === selection.provider),
                        detail: entry?.reason ?? (entry?.available ? undefined : 'Availability unknown') };
                })} onChange={value => {
                    if (locked) void c.setSelection({ provider: value }).catch(err => setError(err instanceof Error ? err.message : String(err)));
                    else void change({ provider: value });
                }} />
            <form className="code-footer-model-form" onSubmit={event => { event.preventDefault(); if (modelText.trim() && !modelDisabled) void change({ model: modelText.trim() }); }}>
                <label className="code-footer-label" htmlFor={`${modelSuggestions}-input`}>Model</label>
                <input id={`${modelSuggestions}-input`} aria-label="Native model ID" list={modelSuggestions} value={modelText}
                    disabled={modelDisabled} onChange={event => setModelText(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Escape') { setModelText(selection.model); event.currentTarget.blur(); } }} />
                <datalist id={modelSuggestions}>{provider?.models.map(model => <option key={model} value={model} />)}</datalist>
                {modelText !== selection.model && <button type="submit" disabled={modelDisabled || !modelText.trim()}>Apply</button>}
            </form>
            {!!capabilities?.efforts.length && <CodeFooterMenu label="Effort" value={selection.effort ?? ''}
                options={[{ value: '', label: 'Native default' }, ...capabilities.efforts.map(value => ({ value, label: value }))]}
                disabled={controlsDisabled} onChange={value => void change({ effort: value || null })} />}
            <CodeFooterMenu label="Permission" value={selection.permissionMode} displayValue={CODE_POLICY_LABELS[selection.permissionMode]} disabled={controlsDisabled || !capabilities?.permissions}
                options={(capabilities?.permissionModes ?? []).map(value => ({ value, label: CODE_POLICY_LABELS[value], detail: CODE_POLICY_DETAILS[value] }))}
                onChange={value => void change({ permissionMode: value })} />
            {locked && <button type="button" className="code-inline-action" onClick={c.newSession}>New session</button>}
        </div>
        {!provider?.available && <div className="code-selection-notice">{provider?.reason ?? 'Runtime availability has not been confirmed.'}
            <button type="button" className="code-inline-action" onClick={() => { void c.refresh().catch(err => setError(err instanceof Error ? err.message : String(err))); }}>Refresh availability</button>
        </div>}
        {selection.permissionMode === 'auto' && <p className="code-policy-note">Auto (YOLO): actions may run without approval.</p>}
        {(saving || c.operation.kind === 'patching') && <span role="status">Saving settings…</span>}
        {error && <div className="code-action-error" role="alert">{error}</div>}
    </>;
}
