import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
const ITEM = {id:'sched-1',title:'wp5c scheduled work',group:'today',cron:'0 9 * * *',runAt:null,enabled:true,targetPort:3506,nextRunAt:null,lastRunAt:null,lastStatus:null,createdAt:'2026-07-26T00:00:00.000Z',updatedAt:'2026-07-26T00:00:00.000Z'};
await page.evaluate((it) => { window.__jawE2E.resetSchedule(); window.__jawE2E.setSchedule({ items: [it], dispatchResult: { status: 'dispatched', message: 'ok', targetPort: 3506 } }); }, ITEM);
await page.evaluate(() => window.__jawE2E.openPanel('reminders'));
await page.waitForTimeout(600);
await page.locator('.d2-reminders-tabs button[role="tab"]:nth-child(2)').click();
await page.waitForTimeout(1000);
console.log('TOGGLE input count:', await page.evaluate(() => document.querySelectorAll('.d2-schedule-switch input').length));
console.log('TOGGLE visible:', await page.locator('.d2-schedule-switch input').first().isVisible().catch(()=>'err'));
// dispatch
const mark = await page.evaluate(() => window.__jawE2E.markRequests());
await page.locator('button[aria-label="Dispatch 판정: wp5c scheduled work"]').click();
await page.waitForTimeout(1200);
console.log('DISPATCH RESULT:', await page.evaluate(() => document.querySelector('.d2-schedule-dispatch-result')?.outerHTML?.slice(0,150) ?? 'none'));
console.log('REQS:', await page.evaluate((s) => window.__jawE2E.allRequests(s).map(r=>r.method+' '+r.pathname), mark));
console.log('CONSOLE:', page.consoleErrors.slice(0,3));
await browser.close(); await server.close();
