// ── Icon System ──
// Central module for all UI icons. Replaces hardcoded emoji strings with
// Lucide SVG icons and custom SVGs. Every file that needs an icon imports
// from here — never use emoji literals in UI code.

import { buildLucideSvg } from '@lucide/icons/build';
import {
    CircleCheck,
    CircleX,
    Wrench,
    SkipForward,
    Brain,
    HeartPulse,
    Lock,
    LockOpen,
    KeyRound,
    Settings,
    FileText,
    Trash2,
    TriangleAlert,
    Lightbulb,
    Search,
    Globe,
    Zap,
    MessageSquare,
    NotebookPen,
    RefreshCw,
    Mic,
    Package,
    ClipboardList,
    Bot,
    Palette,
    Link,
    HandMetal,
    Paperclip,
    Save,
    Gamepad2,
    House,
    Radio,
    FolderOpen,
    Pencil,
    ChartBar,
    Hourglass,
    Square,
    X,
    Send,
    Check,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    ArrowLeft,
    ArrowRight,
} from '@lucide/icons';

// ── Size presets ──
const S = 14;  // inline / small
const M = 16;  // default UI

function luc(data: Parameters<typeof buildLucideSvg>[0], size = M): string {
    return buildLucideSvg(data, { size });
}

// ── Shark mascot (🦈 emoji — brand identity) ──
const SHARK_SVG = '🦈';

// ── Icon registry ──
// Keys match the semantic role, NOT the old emoji codepoint.
export const ICONS = {
    // Status
    check:       luc(CircleCheck),
    error:       luc(CircleX),
    warning:     luc(TriangleAlert),
    skip:        luc(SkipForward),

    // Tool activity
    tool:        luc(Wrench),
    thinking:    luc(MessageSquare),
    search:      luc(Search),
    web:         luc(Globe),
    exec:        luc(Zap),
    compacting:  luc(Package),
    plan:        luc(NotebookPen),

    // App features
    brain:       luc(Brain),
    heartPulse:  luc(HeartPulse),
    lock:        luc(Lock),
    lockOpen:    luc(LockOpen),
    key:         luc(KeyRound),
    settings:    luc(Settings),
    file:        luc(FileText),
    trash:       luc(Trash2),
    lightbulb:   luc(Lightbulb),
    refresh:     luc(RefreshCw),
    mic:         luc(Mic),
    clipboard:   luc(ClipboardList),
    robot:       luc(Bot),
    palette:     luc(Palette),
    link:        luc(Link),
    salute:      luc(HandMetal),

    // Mascot
    shark:       SHARK_SVG,

    // HTML template icons
    paperclip:   luc(Paperclip),
    save:        luc(Save),
    gamepad:     luc(Gamepad2),
    house:       luc(House),
    radio:       luc(Radio),
    folder:      luc(FolderOpen),
    pencil:      luc(Pencil),
    chart:       luc(ChartBar),
    hourglass:   luc(Hourglass),
    stop:        luc(Square),
    close:       luc(X, S),
    send:        luc(Send),
    checkSimple: luc(Check, S),
    chevronLeft: luc(ChevronLeft, S),
    chevronRight:luc(ChevronRight, S),
    chevronDown: luc(ChevronDown, S),
    arrowLeft:   luc(ArrowLeft, S),
    arrowRight:  luc(ArrowRight, S),
} as const;

export type IconName = keyof typeof ICONS;

/** Get an icon SVG string by name, with optional size override. */
export function icon(name: IconName, size?: number): string {
    if (!size || size === M) return ICONS[name];
    // Regenerate at requested size
    return iconMap[name]?.(size) ?? ICONS[name];
}

// ── Size-override helpers (only for icons that support it) ──
const iconMap: Partial<Record<IconName, (s: number) => string>> = {
    check:      (s) => luc(CircleCheck, s),
    error:      (s) => luc(CircleX, s),
    warning:    (s) => luc(TriangleAlert, s),
    skip:       (s) => luc(SkipForward, s),
    tool:       (s) => luc(Wrench, s),
    thinking:   (s) => luc(MessageSquare, s),
    search:     (s) => luc(Search, s),
    web:        (s) => luc(Globe, s),
    exec:       (s) => luc(Zap, s),
    compacting: (s) => luc(Package, s),
    plan:       (s) => luc(NotebookPen, s),
    brain:      (s) => luc(Brain, s),
    heartPulse: (s) => luc(HeartPulse, s),
    lock:       (s) => luc(Lock, s),
    lockOpen:   (s) => luc(LockOpen, s),
    key:        (s) => luc(KeyRound, s),
    settings:   (s) => luc(Settings, s),
    file:       (s) => luc(FileText, s),
    trash:      (s) => luc(Trash2, s),
    lightbulb:  (s) => luc(Lightbulb, s),
    refresh:    (s) => luc(RefreshCw, s),
    mic:        (s) => luc(Mic, s),
    clipboard:  (s) => luc(ClipboardList, s),
    robot:      (s) => luc(Bot, s),
    palette:    (s) => luc(Palette, s),
    link:       (s) => luc(Link, s),
    salute:     (s) => luc(HandMetal, s),
    paperclip:  (s) => luc(Paperclip, s),
    save:       (s) => luc(Save, s),
    gamepad:    (s) => luc(Gamepad2, s),
    house:      (s) => luc(House, s),
    radio:      (s) => luc(Radio, s),
    folder:     (s) => luc(FolderOpen, s),
    pencil:     (s) => luc(Pencil, s),
    chart:      (s) => luc(ChartBar, s),
};

// ── Emoji → Icon name mapping (for server protocol backward compat) ──
const EMOJI_TO_ICON: Record<string, IconName> = {
    '✅': 'check',
    '❌': 'error',
    '🔧': 'tool',
    '⏭': 'skip',
    '🧠': 'brain',
    '💓': 'heartPulse',
    '🔒': 'lock',
    '🔓': 'lockOpen',
    '🔑': 'key',
    '⚙': 'settings',
    '⚙️': 'settings',
    '📄': 'file',
    '🗑': 'trash',
    '🗑️': 'trash',
    '⚠': 'warning',
    '⚠️': 'warning',
    '💡': 'lightbulb',
    '🦈': 'shark',
    '💭': 'thinking',
    '🔍': 'search',
    '🌐': 'web',
    '⚡': 'exec',
    '🗜': 'compacting',
    '🗜️': 'compacting',
    '📝': 'plan',
    '📑': 'clipboard',
    '🤖': 'robot',
    '📋': 'clipboard',
    '🔄': 'refresh',
    '🎨': 'palette',
    '🎤': 'mic',
    '🔗': 'link',
    '🫡': 'salute',
    '📎': 'paperclip',
    '💾': 'save',
    '🎮': 'gamepad',
    '🏠': 'house',
    '📡': 'radio',
    '📂': 'folder',
    '✏️': 'pencil',
    '📊': 'chart',
    '🎙️': 'mic',
};

/** Convert an emoji string to its icon SVG. Falls back to the emoji if unknown. */
export function emojiToIcon(emoji: string): string {
    const name = EMOJI_TO_ICON[emoji];
    return name ? ICONS[name] : emoji;
}

/** Check if a string is a known status emoji. */
export function isCompletionEmoji(emoji: string): boolean {
    return emoji === '✅' || emoji === '❌';
}

/** Get semantic status from an emoji. */
export function emojiToStatus(emoji: string): 'done' | 'error' | null {
    if (emoji === '✅') return 'done';
    if (emoji === '❌') return 'error';
    return null;
}

/**
 * Hydrate all `<span data-icon="NAME">` elements in a container (default: document.body).
 * Call once after DOMContentLoaded to replace HTML icon placeholders with SVGs.
 */
export function hydrateIcons(root: Element = document.body): void {
    const els = root.querySelectorAll<HTMLElement>('[data-icon]');
    for (const el of els) {
        const name = el.dataset.icon as IconName;
        if (name && ICONS[name]) {
            el.innerHTML = ICONS[name];
            el.classList.add('icon-hydrated');
        }
    }
}
