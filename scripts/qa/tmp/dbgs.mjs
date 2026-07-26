import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
await page.evaluate(() => { window.__jawE2E.resetSettingsConfig(); window.__jawE2E.setSettingsConfig({ instanceSaveStatus: 500 }); });
await page.locator('.hover-dock-trigger').click();
await page.locator('.hover-dock-tab[role="tab"]:has-text("에이전트")').click();
await page.waitForTimeout(1500);
console.log('SELECTS:', await page.evaluate(() => [...document.querySelectorAll('.hover-dock-body[data-dock-tab="agents"] select')].map(s=>({v:s.value, opts:[...s.options].map(o=>o.value)}))));
await browser.close(); await server.close();
