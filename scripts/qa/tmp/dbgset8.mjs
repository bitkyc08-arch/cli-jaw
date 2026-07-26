import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
const r = await page.evaluate(([name, config]) => {
    const setterName = `set${name[0].toUpperCase() + name.slice(1)}`;
    const fn = window.__jawE2E[setterName];
    // call and introspect
    const before = JSON.stringify(window.__jawE2E.api.settings);
    fn(config);
    return { setterName, fnType: typeof fn, configReceived: JSON.stringify(config), before, after: JSON.stringify(window.__jawE2E.api.settings) };
}, ['settings', { holdRegistry: true }]);
console.log(JSON.stringify(r, null, 2));
await browser.close(); await server.close();
