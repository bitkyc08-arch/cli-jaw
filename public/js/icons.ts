// ── Icon System ──
// Central module for all UI icons. Replaces hardcoded emoji strings with
// Lucide SVG icons and custom SVGs. Every file that needs an icon imports
// from here — never use emoji literals in UI code.

import { buildLucideSvg } from '@lucide/icons/build';
import { EMOJI_TO_ICON } from './icon-mappings.js';
import {
    CircleCheck,
    CircleX,
    Accessibility,
    Anchor,
    Apple,
    Archive,
    Atom,
    BadgeCheck,
    Bell,
    Bike,
    BookOpen,
    BrickWall,
    BrushCleaning,
    Bug,
    Building2,
    Wrench,
    SkipForward,
    Brain,
    Briefcase,
    CalendarDays,
    Camera,
    Circle,
    CircleHelp,
    HeartPulse,
    Lock,
    LockOpen,
    KeyRound,
    Settings,
    FileText,
    Film,
    Trash2,
    TriangleAlert,
    Cloud,
    Code2,
    Coffee,
    Compass,
    Construction,
    Container,
    Database,
    DollarSign,
    DraftingCompass,
    Dumbbell,
    Factory,
    Lightbulb,
    Fish,
    Flame,
    FlaskConical,
    Gem,
    GitBranch,
    Search,
    Globe,
    Handshake,
    Heart,
    HelpingHand,
    Image,
    Inbox,
    Infinity,
    Landmark,
    Languages,
    Leaf,
    Library,
    Mail,
    Map,
    MapPin,
    Megaphone,
    MessageCircle,
    Microscope,
    Monitor,
    Music,
    Newspaper,
    Notebook,
    PenLine,
    Plug,
    Presentation,
    Puzzle,
    Repeat,
    Rocket,
    Route,
    Ruler,
    ScanEye,
    SearchCheck,
    Shield,
    ShieldAlert,
    ShieldQuestion,
    Ship,
    Siren,
    Smartphone,
    Speaker,
    Terminal,
    Triangle,
    Truck,
    Users,
    Video,
    Volume2,
    WandSparkles,
    Waves,
    Sun,
    TreePine,
    Zap,
    MessageSquare,
    NotebookPen,
    RefreshCw,
    Mic,
    Package,
    ClipboardList,
    Bot,
    CircleUserRound,
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
    Target,
    Square,
    X,
    Send,
    Ban,
    Play,
    Check,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    ArrowLeft,
    ArrowRight,
    Copy,
    Download,
} from '@lucide/icons';

// ── Inline SVG assets (embedded to avoid ?raw import issues in Node.js tests) ──
const sharkSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12c0 0 2-4 6-4 1 0 2 .5 3 1l3-6c0 0 1 5 3 7 1.5 1.5 5 2 5 2s-1 4-5 4c-1 0-2-.3-3-.8L12 18c0 0-2-1-4-1-4 0-6-5-6-5z"/><circle cx="17" cy="11" r="0.5" fill="currentColor" stroke="none"/><path d="M7 12l1 2"/><path d="M9.5 12l1 2"/></svg>';

// ── Size presets ──
const S = 14;  // inline / small
const M = 16;  // default UI

function luc(data: Parameters<typeof buildLucideSvg>[0], size = M): string {
    return buildLucideSvg(data, { size });
}

// ── Default avatar icons (Lucide-based, no emoji literals) ──

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
    message:     luc(MessageCircle),
    unknown:     luc(CircleHelp),
    read:        luc(BookOpen),
    terminal:    luc(Terminal),
    test:        luc(FlaskConical),
    architecture: luc(Construction),
    build:       luc(Building2),
    apple:       luc(Apple),
    statusDot:   luc(Circle),
    video:       luc(Video),
    bug:         luc(Bug),
    ruler:       luc(Ruler),
    drafting:    luc(DraftingCompass),
    library:     luc(Library),
    package:     luc(Package),
    research:    luc(Microscope),
    image:       luc(Image),
    archive:     luc(Archive),
    database:    luc(Database),
    deploy:      luc(Rocket),
    shield:      luc(Shield),
    shieldAlert: luc(ShieldAlert),
    permission:  luc(ShieldQuestion),
    cloud:       luc(Cloud),
    code:        luc(Code2),
    coffee:      luc(Coffee),
    infinity:    luc(Infinity),
    accessibility: luc(Accessibility),
    anchor:      luc(Anchor),
    atom:        luc(Atom),
    mail:        luc(Mail),
    waves:       luc(Waves),
    map:         luc(Map),
    weather:     luc(Sun),
    tree:        luc(TreePine),
    leaf:        luc(Leaf),
    theatre:     luc(Film),
    music:       luc(Music),
    fitness:     luc(Dumbbell),
    institution: luc(Landmark),
    company:     luc(Building2),
    factory:     luc(Factory),
    git:         luc(GitBranch),
    camel:       luc(Code2),
    container:   luc(Container),
    golang:      luc(Fish),
    eye:         luc(ScanEye),
    gem:         luc(Gem),
    heart:       luc(Heart),
    money:       luc(DollarSign),
    briefcase:   luc(Briefcase),
    calendar:    luc(CalendarDays),
    mapPin:      luc(MapPin),
    notebook:    luc(Notebook),
    megaphone:   luc(Megaphone),
    mailIn:      luc(Mail),
    inbox:       luc(Inbox),
    newspaper:   luc(Newspaper),
    mobile:      luc(Smartphone),
    camera:      luc(Camera),
    presentation: luc(Presentation),
    repeat:      luc(Repeat),
    volume:      luc(Volume2),
    plug:        luc(Plug),
    bell:        luc(Bell),
    language:    luc(Languages),
    triangle:    luc(Triangle),
    crawler:     luc(Bug),
    voice:       luc(Speaker),
    hug:         luc(HelpingHand),
    handshake:   luc(Handshake),
    rust:        luc(Code2),
    flutter:     luc(Waves),
    quality:     luc(BadgeCheck),
    wizard:      luc(WandSparkles),
    puzzle:      luc(Puzzle),
    compass:     luc(Compass),
    brick:       luc(BrickWall),
    cleanup:     luc(BrushCleaning),
    truck:       luc(Truck),
    siren:       luc(Siren),
    compliance:  luc(BadgeCheck),
    korea:       luc(Languages),
    people:      luc(Users),
    branch:      luc(GitBranch),
    searchCheck: luc(SearchCheck),
    flame:       luc(Flame),
    monitor:     luc(Monitor),
    route:       luc(Route),
    thread:      luc(GitBranch),
    bike:        luc(Bike),
    ship:        luc(Ship),
    pen:         luc(PenLine),

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

    // Avatar defaults
    shark:       sharkSvg,
    user:        luc(CircleUserRound),

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
    target:      luc(Target),
    ban:         luc(Ban),
    play:        luc(Play),
    stop:        luc(Square),
    close:       luc(X, S),
    send:        luc(Send),
    copy:        luc(Copy, S),
    download:    luc(Download, S),
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
    user:       (s) => luc(CircleUserRound, s),
    paperclip:  (s) => luc(Paperclip, s),
    save:       (s) => luc(Save, s),
    gamepad:    (s) => luc(Gamepad2, s),
    house:      (s) => luc(House, s),
    radio:      (s) => luc(Radio, s),
    folder:     (s) => luc(FolderOpen, s),
    pencil:     (s) => luc(Pencil, s),
    chart:      (s) => luc(ChartBar, s),
    hourglass:  (s) => luc(Hourglass, s),
    target:     (s) => luc(Target, s),
    ban:        (s) => luc(Ban, s),
    play:       (s) => luc(Play, s),
    copy:       (s) => luc(Copy, s),
    download:   (s) => luc(Download, s),
};

export function isIconName(value: string): value is IconName {
    return Object.prototype.hasOwnProperty.call(ICONS, value);
}

export function hasIconMapping(value: string): boolean {
    return isIconName(value) || Object.prototype.hasOwnProperty.call(EMOJI_TO_ICON, value);
}

/** Convert a semantic key or emoji string to an icon SVG. Unknown values use a library fallback. */
export function resolveIcon(value: string | undefined | null, fallback: IconName = 'tool'): string {
    const raw = (value || '').trim();
    if (!raw) return ICONS[fallback];
    if (raw.startsWith('<svg')) return raw;
    if (isIconName(raw)) return ICONS[raw];
    const name = EMOJI_TO_ICON[raw];
    return name ? ICONS[name] : ICONS[fallback];
}

/** Convert an emoji string to its icon SVG. Kept for compatibility with existing call sites. */
export function emojiToIcon(emoji: string): string {
    return resolveIcon(emoji);
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
        const name = el.dataset['icon'] as IconName;
        if (name && ICONS[name]) {
            el.innerHTML = ICONS[name];
            el.classList.add('icon-hydrated');
        }
    }
}
