import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export const setRichDecorationsEffect = StateEffect.define<DecorationSet>();

export const richMarkdownDecorationField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(value, transaction) {
        for (const effect of transaction.effects) {
            if (effect.is(setRichDecorationsEffect)) return effect.value;
        }
        return value.map(transaction.changes);
    },
    provide(field) {
        return EditorView.decorations.from(field);
    },
});
