import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10, viewport: { width: 1920, height: 1000 } });
await page.evaluate(() => { window.__jawE2E.resetBoard(); window.__jawE2E.setBoard({ tasks: [{id:'task-9',title:'wp5c board task',lane:'ready'}] }); });
console.log('RAW:', await page.evaluate(async () => { const r = await fetch('/api/dashboard/board/tasks'); return (await r.text()).slice(0,200); }));
console.log('router.board:', await page.evaluate(() => JSON.stringify(window.__jawE2E.api.board)));
await browser.close(); await server.close();
