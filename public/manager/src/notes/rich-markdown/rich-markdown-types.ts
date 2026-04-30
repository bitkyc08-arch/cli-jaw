import type { Extension } from '@codemirror/state';

export type RichMarkdownKind = 'code' | 'mermaid' | 'math-block' | 'math-inline';

export type RichMarkdownRange = {
    from: number;
    to: number;
    kind: RichMarkdownKind;
    markdown: string;
    block: boolean;
};

export type RichMarkdownWidgetRegistration = {
    id: string;
    kind: RichMarkdownKind;
    markdown: string;
    shell: HTMLElement;
};

export type RichMarkdownExtensionOptions = {
    enabled: boolean;
    active: boolean;
    registerWidget: (registration: RichMarkdownWidgetRegistration) => void;
    unregisterWidget: (id: string) => void;
    requestMeasure: () => void;
};

export type RichMarkdownExtensionFactory = (options: RichMarkdownExtensionOptions) => Extension;

