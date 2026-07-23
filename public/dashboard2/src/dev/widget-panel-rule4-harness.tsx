import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../styles/turn-stream.css';
import { createRoot, type Root } from 'react-dom/client';
import type { DashboardRegistry } from '../../../../src/manager/types.ts';
import { ManagerApiProvider } from '../providers/api-provider.tsx';
import { DesktopBridgeProvider } from '../providers/desktop-bridge-provider.tsx';
import { ManagerPreferencesProvider, type PreferencesRegistryClient } from '../providers/preferences-provider.tsx';
import { AppScopeProvider } from '../state/scope.tsx';
import { SidePane } from '../shell/SidePane.tsx';
import { WidgetSegment } from '../turn-stream/components/segments/WidgetSegment.tsx';
import { createWidgetPanelPayload } from '../turn-stream/widgets/widget-panel-key.ts';
import type { WidgetDescriptor } from '../turn-stream/widgets/widget-segment-adapter.ts';
import { widgetUiStore, type WidgetUiState } from '../turn-stream/widgets/widget-ui-store.ts';

const identity = { scopeKey: 'rule4-harness', turnId: 'turn-1', segmentId: 'widget-1' };
const descriptor: WidgetDescriptor = {
    widgetId: 'rule4-widget',
    title: 'Rule 4 widget',
    estimatedHeight: 120,
    storage: 'inline',
    revision: 'r1',
    capabilities: ['interactive', 'stateful'],
    source: btoa('<!doctype html><button type="button">Rule 4 runtime</button>'),
};
const payload = createWidgetPanelPayload('turn-widget', 'rule4-chat', descriptor, identity)!;
let crashArmed = false;
let root: Root | null = null;

const registry = {
    ui: {
        uiTheme: 'auto',
        locale: 'ko',
        dashboardShortcutsEnabled: true,
        dashboardShortcutKeymap: {},
        chatLinkPreviewsEnabled: false,
    },
} as unknown as DashboardRegistry;

const preferencesClient: PreferencesRegistryClient = {
    async load() { return { registry, status: {} }; },
    async patch() { return { registry, status: {} }; },
};

export interface WidgetPanelRule4Harness {
    panelKey: string;
    armCrash(): void;
    disarmCrash(): void;
    consumeCrash(): boolean;
    snapshot(): Readonly<WidgetUiState> | null;
}

const harness: WidgetPanelRule4Harness = {
    panelKey: payload.panelKey,
    armCrash() { crashArmed = true; },
    disarmCrash() { crashArmed = false; },
    consumeCrash: () => crashArmed,
    snapshot: () => widgetUiStore.getSnapshot()[payload.panelKey] ?? null,
};

function Fixture(): React.JSX.Element {
    return (
        <main data-testid="widget-panel-rule4-harness" style={{ display: 'grid', gridTemplateColumns: '1fr 520px', height: '720px' }}>
            <section data-testid="rule4-inline-widget">
                <WidgetSegment
                    descriptor={descriptor}
                    expanded
                    onToggle={() => {}}
                    chatId="rule4-chat"
                    identity={identity}
                    promotionSource="turn-widget"
                />
            </section>
            <SidePane open onClose={() => {}} />
        </main>
    );
}

declare global {
    interface Window { __jawWidgetPanelRule4?: WidgetPanelRule4Harness }
}

export function mountWidgetPanelRule4Harness(): WidgetPanelRule4Harness {
    const host = document.createElement('div');
    host.id = 'widget-panel-rule4-host';
    document.body.replaceChildren(host);
    root?.unmount();
    root = createRoot(host);
    crashArmed = false;
    window.__jawWidgetPanelRule4 = harness;
    root.render(
        <ManagerApiProvider>
            <ManagerPreferencesProvider client={preferencesClient}>
                <DesktopBridgeProvider>
                    <AppScopeProvider>
                        <Fixture />
                    </AppScopeProvider>
                </DesktopBridgeProvider>
            </ManagerPreferencesProvider>
        </ManagerApiProvider>,
    );
    return harness;
}
