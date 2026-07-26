import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
await page.evaluate(() => window.__jawE2E.openPanel('notes'));
await page.waitForTimeout(1200);
console.log('TREE ITEMS:', await page.evaluate(() => [...document.querySelectorAll('.d2-notes-tree-item')].map(i=>i.textContent.trim()+' ['+(i.getAttribute('role'))+']')));
console.log('RENAME BTN:', await page.evaluate(() => document.querySelector('button[aria-label="Rename today.md"]') ? 'found' : 'NOT FOUND'));
await browser.close(); await server.close();
