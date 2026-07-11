import { buildLucideSvg } from '@lucide/icons/build';
import type { JSX } from 'react';

type LucideIconData = Parameters<typeof buildLucideSvg>[0];

interface IconProps {
    icon: LucideIconData;
    size?: number;
}

export function Icon({ icon, size = 16 }: IconProps): JSX.Element {
    return (
        <span
            className="d2-icon"
            aria-hidden="true"
            dangerouslySetInnerHTML={{
                __html: buildLucideSvg(icon, { size, strokeWidth: 1.8 }),
            }}
        />
    );
}
