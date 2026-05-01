import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import {
    commands,
    inputRules,
    keymap,
    markInputRules,
    pasteRules,
    plugins,
    schema,
    wrapInTaskListInputRule,
} from '@milkdown/kit/preset/gfm';

const safeInputRules = inputRules.filter(rule => rule !== wrapInTaskListInputRule);

export const notesMilkdownGfm: MilkdownPlugin[] = [
    schema,
    safeInputRules,
    markInputRules,
    pasteRules,
    keymap,
    commands,
    plugins,
].flat();
