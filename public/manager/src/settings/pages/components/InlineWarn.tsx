// Phase 7 — Inline warning panel used by Network/Permissions pages to surface
// safety implications next to the field that triggers them.

import type { ReactNode } from 'react';

type Props = {
    children: ReactNode;
    tone?: 'warn' | 'info';
    role?: 'alert' | 'note';
};

export function InlineWarn({ children, tone = 'warn', role = 'note' }: Props) {
    const className = `settings-inline-warn settings-inline-warn-${tone}`;
    if (role === 'alert') {
        return (
            <p className={className} role="alert">
                {children}
            </p>
        );
    }
    return (
        <p className={className} role="note">
            {children}
        </p>
    );
}
