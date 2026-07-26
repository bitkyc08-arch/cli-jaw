import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
const r = await page.evaluate(() => {
    window.__jawE2E.setSettings({ holdRegistry: true });
    return JSON.stringify(window.__jawE2E.api.settings);
});
console.log('DIRECT SET:', r);
const has = await page.evaluate(() => typeof window.__jawE2E.setSettings);
console.log('setSettings type:', has);
const keys = await page.evaluate(() => Object.keys(window.__jawE2E).join(','));
console.log('E2E keys:', keys);
await browser.close(); await server.close();
