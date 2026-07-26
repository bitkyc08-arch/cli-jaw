import { openFixture, startFixtureServer } from '../fixture-lib.mjs';
const server = await startFixtureServer();
const { browser, page } = await openFixture(server.url, { historyCount: 10 });
// 1. no-selection: default fixture, no click
await page.evaluate(() => { window.__jawE2E.resetNotes(); window.__jawE2E.setNotes({}); });
await page.evaluate(() => window.__jawE2E.openPanel('notes'));
await page.waitForTimeout(1500);
console.log('WORKSPACE:', await page.evaluate(() => document.querySelector('.d2-notes-workspace')?.outerHTML?.slice(0,250) ?? 'none'));
console.log('EMPTY-STATE count:', await page.evaluate(() => document.querySelectorAll('.d2-notes-empty-state').length));
console.log('SELECTED? tree item selected:', await page.evaluate(() => document.querySelector('.d2-notes-tree-item[aria-selected="true"], .d2-notes-tree-item.is-selected')?.textContent?.trim() ?? 'none'));
await browser.close(); await server.close();
