import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
await page.evaluate(() => { window.__jawE2E.resetHoverDock(); window.__jawE2E.setHoverDock({ skills: [] }); });
await page.locator('.hover-dock-trigger').click();
await page.locator('.hover-dock-tab[role="tab"]:has-text("스킬")').click();
await page.waitForTimeout(1500);
console.log('TEXT:', await page.evaluate(() => document.querySelector('.hover-dock-body[data-dock-tab="skills"]')?.textContent?.replace(/\s+/g,' ').trim()));
await browser.close(); await server.close();
