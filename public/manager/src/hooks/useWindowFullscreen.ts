import { useEffect } from 'react';
import { getDesktop } from '../panels/desktop-bridge';

function readFullscreenState(): boolean {
    return getDesktop()?.window?.getFullscreenState?.() === true;
}

export function useWindowFullscreen(): boolean {
    useEffect(() => {
        const root = document.documentElement;
        const apply = (next: boolean): void => {
            if (next) root.dataset['windowFullscreen'] = 'true';
            else delete root.dataset['windowFullscreen'];
        };
        apply(readFullscreenState());
        const unsubscribe = getDesktop()?.window?.onFullscreenStateChange?.(apply);
        return () => {
            unsubscribe?.();
            delete root.dataset['windowFullscreen'];
        };
    }, []);
    return readFullscreenState();
}
