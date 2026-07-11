import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { chromium, type Browser } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..', '..');
const browsers: Browser[] = [];
after(async () => Promise.allSettled(browsers.map(browser => browser.close())));

async function launchChromium(t: TestContext): Promise<Browser | null> {
    const attempts = [
        () => chromium.launch({ headless: true, channel: 'chrome' }),
        () => chromium.launch({ headless: true }),
    ];
    for (const attempt of attempts) {
        try {
            const browser = await attempt();
            browsers.push(browser);
            return browser;
        } catch { /* try the next locally installed executable */ }
    }
    t.skip('no local Chrome/Chromium executable for dashboard2 composer structure');
    return null;
}

test('046 browser structure: one 25px squircle and ordered controls', async t => {
    const source = readFileSync(resolve(ROOT, 'public/dashboard2/src/chat/composer/ComposerFooter.tsx'), 'utf8');
    const css = readFileSync(resolve(ROOT, 'public/dashboard2/src/chat/composer/composer.css'), 'utf8');
    assert.match(css, /\.d2-composer-pill\s*\{[^}]*border-radius:\s*25px/s);
    assert.match(css, /corner-shape:\s*superellipse\(1\.5\)/);
    assert.ok(source.indexOf('onAttach') < source.indexOf('Full access'));
    assert.ok(source.indexOf('d2-composer-picker') < source.indexOf('Start voice input'));
    assert.ok(source.indexOf('Start voice input') < source.indexOf('Send message'));
    assert.match(source, /props\.goalLabel \?/);

    const browser = await launchChromium(t);
    if (!browser) return;
    const page = await browser.newPage({ viewport: { width: 900, height: 300 } });
    await page.setContent(`<style>${css}</style><div class="d2-composer-wrap"><div class="d2-composer-pill" data-testid="pill"><textarea>Message</textarea><div class="d2-composer-footer"><div class="d2-composer-controls"><button class="d2-composer-icon">+</button><button class="d2-composer-access">Full access</button></div><div class="d2-composer-controls"><button class="d2-composer-picker">claude · opus Ultra</button><button class="d2-composer-icon">mic</button><button class="d2-composer-icon d2-composer-primary">send</button></div></div></div></div>`);
    const metrics = await page.locator('[data-testid="pill"]').evaluate(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { radius: style.borderRadius, width: rect.width, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(metrics.radius, '25px');
    assert.ok(metrics.width <= 700);
    assert.equal(metrics.overflow, false);
});
