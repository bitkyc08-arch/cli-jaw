import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
await page.evaluate(() => { window.__jawE2E.resetBoard(); window.__jawE2E.setBoard({ tasks: [{id:'task-1',title:'wp5c board task',lane:'ready'}] }); });
await page.evaluate(() => window.__jawE2E.openPanel('board'));
await page.waitForTimeout(1800);
console.log('ERR:', await page.evaluate(() => document.querySelector('.d2-board-error')?.textContent?.trim() ?? 'none'));
console.log('CARDS:', await page.evaluate(() => document.querySelectorAll('.d2-board-card').length));
console.log('LANES:', await page.evaluate(() => [...document.querySelectorAll('.d2-board-lane-header')].map(h => h.textContent.trim().replace(/\s+/g,' '))));
// create flow
await page.evaluate(() => { window.__jawE2E.resetBoard(); window.__jawE2E.setBoard({ tasks: [], holdCreate: true }); });
await page.locator('.d2-board-create-button').click();
await page.locator('.d2-board-title-field input').fill('wp5c new board task');
const mark = await page.evaluate(() => window.__jawE2E.markRequests());
await page.locator('.d2-board-submit:not([disabled])').click();
await page.waitForTimeout(1000);
console.log('SUBMIT BTN:', await page.evaluate(() => document.querySelector('.d2-board-submit')?.outerHTML?.slice(0,150)));
console.log('REQS:', await page.evaluate((s) => window.__jawE2E.codeRequests(s).map(r=>r.method+' '+r.pathname+' '+JSON.stringify(r.body)), mark));
await browser.close(); await server.close();
