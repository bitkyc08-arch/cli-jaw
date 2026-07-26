import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
await page.evaluate(() => window.__jawE2E.openPanel('notes'));
await page.waitForTimeout(2000);
console.log('RAW tree:', await page.evaluate(async () => { const r = await fetch('/api/dashboard/notes/tree'); return (await r.text()).slice(0,150); }));
console.log('RAW index:', await page.evaluate(async () => { const r = await fetch('/api/dashboard/notes/index'); return (await r.text()).slice(0,120); }));
console.log('MODEL ERR:', await page.evaluate(() => document.querySelector('.d2-notes-notice.is-error')?.textContent?.trim() ?? 'none'));
await browser.close(); await server.close();
