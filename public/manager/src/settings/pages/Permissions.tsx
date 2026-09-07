// Phase 7 — Permissions page: Auto vs Custom (string[] allowlist).
//
// Pure helpers (`isPermissionsAuto`, `parsePermissionsValue`, `isPermissionToken`,
// `seedAutoAllowlist`) are exported so the unit tests can drive the union-typed
// `permissions` field without mounting the React component.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SettingsPageProps, DirtyEntry } from '../types';
import { ChipListField, SelectField } from '../fields';
import {
    SettingsSection,
    PageError,
    PageLoading,
    PageOffline,
    usePageSnapshot,
} from './page-shell';
import { InlineWarn } from './components/InlineWarn';

export type PermissionMode = 'auto' | 'custom';

type PermissionsSnapshot = {
    permissions?: 'auto' | string[] | unknown;
    [key: string]: unknown;
};

// Permission tokens accepted by the runtime. We don't enforce a closed set —
// MCP namespaces (`mcp.*`) and tool-specific tokens grow over time — but we
// do validate the *shape* so a stray space, control char, or empty chip can't
// slip through.
const TOKEN_RE = /^[a-zA-Z0-9._:*-]+$/;

const DEFAULT_AUTO_TOKENS: ReadonlyArray<string> = [
    'bash',
    'read',
    'write',
    'edit',
    'mcp.*',
];

// ─── Pure helpers (exported for tests) ───────────────────────────────

export function configuredPolicyLabel(value: unknown): string {
    if (value === 'auto') return 'Auto (YOLO)';
    if (value === 'safe') return 'Safe';
    if (value === null || value === undefined) return 'Not provided';
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        return `Custom (${value.length} ${value.length === 1 ? 'entry' : 'entries'})`;
    }
    return 'Unrecognized';
}

export function isPermissionsAuto(value: unknown): value is 'auto' {
    return value === 'auto';
}

/** Coerce the union-typed `permissions` field into a discriminated shape. */
export function parsePermissionsValue(
    value: unknown,
):
    | { mode: 'auto' }
    | { mode: 'custom'; tokens: string[] }
    | { mode: 'unknown' } {
    if (isPermissionsAuto(value)) return { mode: 'auto' };
    if (Array.isArray(value)) {
        const tokens = value
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        return { mode: 'custom', tokens };
    }
    return { mode: 'unknown' };
}

export function isPermissionToken(token: string): boolean {
    if (typeof token !== 'string') return false;
    if (token.length === 0 || token.length > 64) return false;
    // Strict shape on the literal — no trim. A token containing whitespace,
    // newline, quote, or control char must fail outright.
    return TOKEN_RE.test(token);
}

/**
 * Provide starter tokens when the user switches Auto (YOLO) → Custom.
 * Use valid supplied tokens when available; otherwise use built-in defaults.
 * These starter tokens do not describe the Auto (YOLO) policy.
 */
export function seedAutoAllowlist(
    resolved?: ReadonlyArray<string> | null,
): string[] {
    if (Array.isArray(resolved) && resolved.length > 0) {
        return Array.from(new Set(resolved.filter(isPermissionToken)));
    }
    return [...DEFAULT_AUTO_TOKENS];
}

export function isAllowlistValid(tokens: ReadonlyArray<string>): boolean {
    if (tokens.length === 0) return false;
    return tokens.every(isPermissionToken);
}

// ─── Page component ──────────────────────────────────────────────────

const MODE_OPTIONS = [
    { value: 'auto', label: 'Auto (YOLO)' },
    { value: 'custom', label: 'Custom — explicit allowlist below' },
];

export default function Permissions({ port, client, dirty, registerSave }: SettingsPageProps) {
    const { state, refresh, setData } = usePageSnapshot<PermissionsSnapshot>(
        client,
        '/api/settings',
    );
    const [mode, setMode] = useState<PermissionMode>('auto');
    const [tokens, setTokens] = useState<string[]>([]);

    const original = useMemo(
        () => (state.kind === 'ready' ? parsePermissionsValue(state.data.permissions) : null),
        [state],
    );

    useEffect(() => {
        if (state.kind !== 'ready') return;
        const parsed = parsePermissionsValue(state.data.permissions);
        if (parsed.mode === 'custom') {
            setMode('custom');
            setTokens(parsed.tokens);
        } else {
            setMode('auto');
            setTokens([]);
        }
    }, [state]);

    useEffect(() => {
        return () => {
            dirty.remove('permissions');
        };
    }, [dirty]);

    const writeEntry = useCallback(
        (entry: DirtyEntry) => dirty.set('permissions', entry),
        [dirty],
    );

    const originalSerialized = useMemo<'auto' | string[]>(() => {
        if (!original) return 'auto';
        if (original.mode === 'custom') return original.tokens;
        return 'auto';
    }, [original]);

    const handleModeChange = useCallback(
        (next: string) => {
            if (next === 'auto') {
                setMode('auto');
                setTokens([]);
                writeEntry({
                    value: 'auto',
                    original: originalSerialized,
                    valid: true,
                });
                return;
            }
            if (next === 'custom') {
                setMode('custom');
                const seed =
                    original && original.mode === 'custom' && original.tokens.length > 0
                        ? [...original.tokens]
                        : seedAutoAllowlist(null);
                setTokens(seed);
                writeEntry({
                    value: seed,
                    original: originalSerialized,
                    valid: isAllowlistValid(seed),
                });
            }
        },
        [original, originalSerialized, writeEntry],
    );

    const handleTokensChange = useCallback(
        (next: string[]) => {
            const cleaned = next.map((t) => t.trim()).filter((t) => t.length > 0);
            setTokens(cleaned);
            writeEntry({
                value: cleaned,
                original: originalSerialized,
                valid: isAllowlistValid(cleaned),
            });
        },
        [originalSerialized, writeEntry],
    );

    const onSave = useCallback(async () => {
        const bundle = dirty.saveBundle();
        if (Object.keys(bundle).length === 0) return;
        // Save bundle from this page only carries `permissions`. We trust the
        // dirty store's `valid` flag — invalid entries are already filtered.
        const updated = await client.put<PermissionsSnapshot>('/api/settings', bundle);
        const fresh = (updated && typeof updated === 'object' && 'data' in updated
            ? (updated as { data: PermissionsSnapshot }).data
            : updated) as PermissionsSnapshot;
        dirty.clear();
        const parsed = parsePermissionsValue(fresh.permissions);
        if (parsed.mode === 'custom') {
            setMode('custom');
            setTokens(parsed.tokens);
        } else {
            setMode('auto');
            setTokens([]);
        }
        setData(fresh);
        await refresh();
    }, [client, dirty, refresh, setData]);

    useEffect(() => {
        if (!registerSave) return;
        registerSave(onSave);
        return () => registerSave(null);
    }, [registerSave, onSave]);

    if (state.kind === 'loading') return <PageLoading />;
    if (state.kind === 'offline') return <PageOffline port={port} />;
    if (state.kind === 'error') return <PageError message={state.message} />;

    const invalidChips = tokens.filter((t) => !isPermissionToken(t));
    const hasInvalid = invalidChips.length > 0;
    const isEmpty = mode === 'custom' && tokens.length === 0;

    const activeSummary = configuredPolicyLabel(state.data.permissions);

    return (
        <form className="settings-page-form" onSubmit={(event) => event.preventDefault()}>
            <SettingsSection
                title="Permissions"
                hint="Selecting a value changes the draft. Save applies it. Auto (YOLO) requests automatic approval or permission bypass. Behavior varies by runtime."
            >
                <SelectField
                    id="permissions-mode"
                    label="Change policy to"
                    value={mode}
                    options={MODE_OPTIONS}
                    onChange={handleModeChange}
                />
                {mode === 'custom' && (
                    <>
                        <ChipListField
                            id="permissions-allowlist"
                            label="Allowlist"
                            value={tokens}
                            onChange={handleTokensChange}
                            placeholder="bash, read, mcp.*"
                            error={
                                hasInvalid
                                    ? `Invalid token${invalidChips.length === 1 ? '' : 's'}: ${invalidChips.join(', ')}`
                                    : isEmpty
                                        ? 'Allowlist cannot be empty in Custom mode.'
                                        : null
                            }
                        />
                        <p className="settings-section-hint">
                            Each chip is a permission token. Examples: <code>bash</code>,
                            <code> read</code>, <code> write</code>, <code> mcp.*</code>.
                        </p>
                        {isEmpty && (
                            <InlineWarn role="alert">
                                An empty Custom allowlist cannot be saved.
                                Add at least one token or switch back to Auto (YOLO).
                            </InlineWarn>
                        )}
                    </>
                )}
            </SettingsSection>

            <SettingsSection
                title="Saved policy"
                hint="Shows the saved permission policy."
            >
                <p className="settings-readonly-line">
                    <span className="settings-field-label">Configured policy:</span>{' '}
                    <span>{activeSummary}</span>
                </p>
                {original?.mode === 'unknown' ? (
                    <p className="settings-section-hint">Use Agent to change this configured policy.</p>
                ) : null}
            </SettingsSection>
        </form>
    );
}
