import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
const r = await page.evaluate(([name, config]) => {
    const setter = window.__jawE2E[`set${name[0].toUpperCase() + name.slice(1)}`];
    const resetter = window.__jawE2E[`reset${name[0].toUpperCase() + name.slice(1)}`];
    resetter?.();
    setter(config);
    return JSON.stringify(window.__jawE2E.api.settingsConfig);
}, ['settingsConfig', { holdRegistry: true }]);
console.log('LEVER:', r);
await page.evaluate(() => window.__jawE2E.setSettings());
await page.waitForTimeout(600);
console.log('STATE:', await page.evaluate(() => document.querySelector('.d2-settings-state')?.outerHTML?.slice(0,150) ?? 'none'));
await browser.close(); await server.close();
