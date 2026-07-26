import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
const r = await page.evaluate(() => {
    const before = JSON.stringify(window.__jawE2E.api.settings);
    window.__jawE2E.api.settings = { holdRegistry: true };
    const afterDirect = JSON.stringify(window.__jawE2E.api.settings);
    window.__jawE2E.setSettings({ holdRegistry: true, registryStatus: 500 });
    const afterSetter = JSON.stringify(window.__jawE2E.api.settings);
    return { before, afterDirect, afterSetter };
});
console.log(JSON.stringify(r, null, 2));
await browser.close(); await server.close();
