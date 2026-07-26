import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
const r = await page.evaluate(() => {
    return { setterSrc: window.__jawE2E.setSettings.toString(), codeSetter: window.__jawE2E.setCode.toString() };
});
console.log('setSettings:', r.setterSrc);
console.log('setCode:', r.codeSetter);
await browser.close(); await server.close();
