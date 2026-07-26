import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
const r = await page.evaluate(() => {
    return {
        setterSrc: window.__jawE2E.setSettings.toString(),
        resetSrc: window.__jawE2E.resetSettings.toString(),
        apiKeys: Object.keys(window.__jawE2E.api).filter(k=>/ett|oard|ote|inder|chedule|mploy|ode/.test(k)),
    };
});
console.log('SETTER:', r.setterSrc);
console.log('RESET:', r.resetSrc);
console.log('API KEYS:', r.apiKeys);
await browser.close(); await server.close();
