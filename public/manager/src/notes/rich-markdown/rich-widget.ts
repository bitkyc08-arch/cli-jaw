import { WidgetType } from '@codemirror/view';
import type { RichMarkdownExtensionOptions, RichMarkdownKind } from './rich-markdown-types';

type RichMarkdownWidgetOptions = Pick<RichMarkdownExtensionOptions, 'registerWidget' | 'unregisterWidget' | 'requestMeasure'> & {
    id: string;
    kind: RichMarkdownKind;
    markdown: string;
    block: boolean;
};

export class RichMarkdownWidget extends WidgetType {
    constructor(private readonly options: RichMarkdownWidgetOptions) {
        super();
    }

    override eq(other: WidgetType): boolean {
        if (!(other instanceof RichMarkdownWidget)) return false;
        return this.options.id === other.options.id
            && this.options.kind === other.options.kind
            && this.options.markdown === other.options.markdown;
    }

    override toDOM(): HTMLElement {
        const shell = document.createElement(this.options.block ? 'div' : 'span');
        shell.className = this.options.block
            ? 'cm-rich-widget cm-rich-block'
            : 'cm-rich-widget cm-rich-inline';
        shell.dataset['richWidgetId'] = this.options.id;
        shell.dataset['richWidgetKind'] = this.options.kind;
        this.options.registerWidget({
            id: this.options.id,
            kind: this.options.kind,
            markdown: this.options.markdown,
            shell,
        });
        queueMicrotask(this.options.requestMeasure);
        return shell;
    }

    override updateDOM(shell: HTMLElement): boolean {
        this.options.registerWidget({
            id: this.options.id,
            kind: this.options.kind,
            markdown: this.options.markdown,
            shell,
        });
        queueMicrotask(this.options.requestMeasure);
        return true;
    }

    override destroy(): void {
        this.options.unregisterWidget(this.options.id);
    }

    override get estimatedHeight(): number {
        return this.options.block ? 96 : 20;
    }

    override ignoreEvent(): boolean {
        return false;
    }
}
