import '../styles/base.css';
import '../styles/tokens-v4.css';
import '../styles/sidebar-v4.css';
import '../chat/composer/composer.css';
import '../code/code-tab.css';

const PHASES = ['I', 'P', 'A', 'B', 'C', 'D'] as const;

export function mountThemeEvidenceHarness(target: HTMLElement): void {
    target.innerHTML = `
        <main class="d2-theme-evidence" style="min-height:100vh;background:var(--bg);color:var(--text);padding:16px;box-sizing:border-box">
            <aside class="d2-sidebar-v4" data-testid="glass" style="position:absolute;width:220px;height:180px"><span>Glass sidebar</span></aside>
            <section data-testid="panel" style="box-sizing:border-box;margin-left:240px;width:var(--evidence-panel-width,280px);max-width:calc(100vw - 272px);min-width:0;overflow:hidden;border:1px solid var(--border);background:var(--surface);color:var(--text);padding:12px">
                <button data-testid="focus" style="border:1px solid var(--accent);outline:2px solid var(--accent-soft);background:var(--surface-h);color:var(--text)">Focus</button>
                <p data-testid="secondary" style="color:var(--text-2)">Secondary text remains visible at every supported panel width.</p>
                <div class="d2-code-session-picker">
                    <button class="d2-code-session-row"><strong>Long code session title that must remain contained</strong><span>/workspace/dashboard2/very/long/path</span></button>
                </div>
                <div data-testid="statuses"><span style="color:var(--positive)">positive</span> <span style="color:var(--warn)">warning</span> <span style="color:var(--danger)">danger</span></div>
                ${PHASES.map(phase => `<div class="d2-composer-pill" data-phase="${phase}" data-testid="phase-${phase}">${phase}</div>`).join('')}
            </section>
        </main>`;
}
