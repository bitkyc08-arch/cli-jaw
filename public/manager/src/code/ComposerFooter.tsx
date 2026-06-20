import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { PermissionMode } from './code-types';

type ComposerFooterProps = {
    provider: string;
    providerOptions: string[];
    model: string;
    modelOptions: string[];
    effort: string;
    effortOptions: string[];
    permissionMode: PermissionMode;
    disabled: boolean;
    onProviderChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onEffortChange: (value: string) => void;
    onPermissionModeChange: (value: PermissionMode) => void;
};

const permissionDescriptions: Record<PermissionMode, string> = {
    ask: 'Prompt before gated tools',
    'always-allow': 'Select JWC allow_always',
    'always-deny': 'Select JWC reject_always',
};

const permissionOptions: Array<{ value: PermissionMode; label: string; detail: string }> = [
    { value: 'ask', label: 'Ask for approval', detail: 'Prompt before gated tools' },
    { value: 'always-allow', label: 'Approve for me', detail: 'Select JWC allow_always' },
    { value: 'always-deny', label: 'Reject for me', detail: 'Select JWC reject_always' },
];

type FooterMenuProps<T extends string> = {
    label: string;
    value: T;
    options: Array<{ value: T; label: string; detail?: string }>;
    disabled: boolean;
    title: string;
    className?: string;
    onChange: (value: T) => void;
};

function FooterMenu<T extends string>({ label, value, options, disabled, title, className = '', onChange }: FooterMenuProps<T>) {
    const menuId = useId();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(false);
    const selected = options.find(option => option.value === value) ?? options[0];
    const selectedIndex = Math.max(0, options.findIndex(option => option.value === selected?.value));

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current?.contains(event.target as Node)) return;
            setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open]);

    const choose = (next: T) => {
        onChange(next);
        setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (disabled) return;
        if (event.key === 'Escape') {
            setOpen(false);
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            const next = options[(selectedIndex + direction + options.length) % options.length];
            if (next) choose(next.value);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(current => !current);
        }
    };

    return (
        <div ref={rootRef} className={`code-footer-menu ${className}`.trim()}>
            <button
                type="button"
                className="code-footer-menu-trigger"
                disabled={disabled}
                title={title}
                aria-label={label}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={menuId}
                onClick={() => setOpen(current => !current)}
                onKeyDown={onKeyDown}
            >
                <span className="code-footer-label">{label}</span>
                <strong>{selected?.label ?? value}</strong>
                <span className="code-footer-chevron" aria-hidden="true">⌃</span>
            </button>
            {open && (
                <div id={menuId} className="code-footer-dropup" role="listbox" aria-label={label}>
                    {options.map(option => (
                        <button
                            type="button"
                            key={option.value}
                            className={`code-footer-dropup-option${option.value === value ? ' is-selected' : ''}`}
                            role="option"
                            aria-selected={option.value === value}
                            onClick={() => choose(option.value)}
                        >
                            <span>
                                <strong>{option.label}</strong>
                                {option.detail && <small>{option.detail}</small>}
                            </span>
                            {option.value === value && <em aria-hidden="true">✓</em>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function ComposerFooter({
    provider, providerOptions,
    model, modelOptions,
    effort, effortOptions,
    permissionMode,
    disabled,
    onProviderChange, onModelChange, onEffortChange, onPermissionModeChange,
}: ComposerFooterProps) {
    return (
        <div className="code-composer-footer">
            <FooterMenu
                label="Permission"
                value={permissionMode}
                options={permissionOptions}
                disabled={disabled}
                title={permissionDescriptions[permissionMode]}
                onChange={onPermissionModeChange}
            />
            {providerOptions.length > 0 && (
                <FooterMenu
                    label="Provider"
                    value={provider}
                    options={providerOptions.map(p => ({ value: p, label: p }))}
                    disabled={disabled}
                    title={provider}
                    onChange={onProviderChange}
                />
            )}
            <FooterMenu
                label="Model"
                value={model}
                options={modelOptions.map(m => ({ value: m, label: m }))}
                disabled={disabled}
                title={model}
                className="code-footer-field-model"
                onChange={onModelChange}
            />
            {effortOptions.length > 0 && (
                <FooterMenu
                    label="Effort"
                    value={effort}
                    options={effortOptions.map(e => ({ value: e, label: e }))}
                    disabled={disabled}
                    title={effort}
                    onChange={onEffortChange}
                />
            )}
        </div>
    );
}
