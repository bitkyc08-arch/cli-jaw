import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
// mimic the runner exactly
const r = await page.evaluate(([name, config]) => {
    const setter = window.__jawE2E[`set${name[0].toUpperCase() + name.slice(1)}`];
    const resetter = window.__jawE2E[`reset${name[0].toUpperCase() + name.slice(1)}`];
    resetter?.();
    setter(config);
    return JSON.stringify(window.__jawE2E.api.settings);
}, ['settings', { holdRegistry: true }]);
console.log('RUNNER PATH:', r);
await browser.close(); await server.close();
