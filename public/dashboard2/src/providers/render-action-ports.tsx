import { createContext, useContext, useMemo, type JSX, type ReactNode } from 'react';

export interface RenderActionPorts {
    workerPort: number | null;
    submitMessage(prompt: string): Promise<void>;
    copyText(text: string): Promise<void>;
    openExternal(url: string): void;
    openProtocol(url: string): void;
    announce(text: string): void;
}

const defaults: RenderActionPorts = {
    workerPort: null,
    submitMessage: async () => { throw new Error('No composer is registered for this chat.'); },
    copyText: async () => {}, openExternal: () => {}, openProtocol: () => {}, announce: () => {},
};
const Context = createContext<RenderActionPorts>(defaults);
export function RenderActionPortsProvider({ ports, children }: { ports: Partial<RenderActionPorts>; children: ReactNode }): JSX.Element {
    const value = useMemo(() => ({ ...defaults, ...ports }), [ports]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useRenderActionPorts(): RenderActionPorts { return useContext(Context); }
