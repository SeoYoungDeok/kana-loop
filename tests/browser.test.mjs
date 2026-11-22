import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { parseCatalog } from '../src/catalog/catalog.ts';

const catalogFile = new URL('../kana-loop-catalog-v1.0.csv', import.meta.url);
const answers = new Map(parseCatalog(await readFile(catalogFile, 'utf8')).map((kana) => [kana.kana, kana]));
const dist = new URL('../dist/', import.meta.url);
const types = {
  html: 'text/html', js: 'text/javascript', css: 'text/css',
  webmanifest: 'application/manifest+json', png: 'image/png',
};

async function assertText(page, selector, text) {
  await page.waitForFunction(([selector, text]) =>
    document.querySelector(selector)?.textContent?.includes(text), [selector, text]);
}

async function waitReady(page) {
  await page.locator('main[aria-busy="false"]').waitFor();
}

test('production browser flow preserves quiz, backup and offline data across an update', { timeout: 60_000 }, async (t) => {
  let updated = false;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    try {
      const requested = new URL(file, dist);
      if (!requested.href.startsWith(dist.href)) throw new Error('Outside build directory');
      let body = await readFile(requested);
      if (updated && file === 'index.html') {
        body = body.toString().replace('<title>Kana Loop</title>', '<title>Kana Loop • update</title>');
      }
      if (updated && file === 'sw.js') {
        body = body.toString().replace(/^const version = "[^"]+";/m, 'const version = "browser-test-update";');
      }
      response.writeHead(200, { 'Content-Type': types[file.split('.').at(-1)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const browser = await chromium.launch({ channel: process.env.KANA_CHROME_CHANNEL || undefined });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const directReference = await context.newPage();
  await directReference.goto(base + '#answers');
  await assertText(directReference, '#answer-count', '208자');
  await waitReady(directReference);
  await page.goto(base);
  await waitReady(page);
  await directReference.close();
  const answer = page.locator('#answer');
  const kana = page.locator('#question-kana');
  const initialKana = await kana.textContent();
  assert.equal(await answer.evaluate((input) => document.activeElement === input), true);
  const layout = await page.locator('.prompt-card').boundingBox();
  assert.equal(layout.width, 600);
  assert.equal(layout.x, 340);

  await answer.fill('draft');
  await page.getByRole('link', { name: '정답표' }).click();
  await page.getByRole('heading', { name: '가나 정답표' }).waitFor();
  await assertText(page, '#answer-count', '208자');
  const firstGrid = page.getByRole('list', { name: '청음', exact: true });
  const columns = () => firstGrid.evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
  assert.equal(await columns(), 4);
  await page.setViewportSize({ width: 390, height: 800 });
  assert.equal(await columns(), 2);
  await page.setViewportSize({ width: 1280, height: 800 });
  const listed = await page.locator('#answer-grids .answer-card').evaluateAll((cards) =>
    cards.flatMap((card) => {
      return [...card.querySelectorAll('.answer-glyphs span')].map((glyph) => {
        const readings = ['ko', 'romaji'].map((language) => {
          const reading = card.querySelector(`[data-reading="${language}"]`);
          return [reading.querySelector('strong').textContent,
            ...(reading.querySelector('.reading-variants')?.textContent.split(', ') ?? [])];
        });
        return [glyph.textContent, ...readings];
      });
    }));
  assert.equal(listed.length, answers.size);
  for (const [glyph, korean, romaji] of listed) {
    assert.deepEqual(korean, answers.get(glyph).acceptedKo);
    assert.deepEqual(romaji, answers.get(glyph).acceptedRomaji);
  }
  const inputSearch = page.getByRole('searchbox', { name: '가나 또는 발음 검색' });
  await inputSearch.fill('  TU ');
  const tsu = page.locator('#answer-grids .answer-card:visible').filter({ hasText: 'つ' });
  assert.match(await tsu.textContent(), /つツ쓰\s*츠tsu\s*tu/);
  await inputSearch.fill('キャ');
  await assertText(page, '#answer-count', '2자');
  await assertText(page, '.answer-section:not([hidden]) .answer-card:not([hidden])', 'きゃ');
  await inputSearch.fill('no-matches-127');
  await page.getByText('검색 결과가 없습니다.').waitFor();
  await page.goBack();
  await answer.waitFor();
  assert.equal(await kana.textContent(), initialKana);
  assert.equal(await answer.inputValue(), 'draft');
  await answer.fill('');
  await answer.press('Enter');
  await assertText(page, '#today-count', '0문항');

  await answer.fill(answers.get(initialKana).primaryKo);
  await answer.dispatchEvent('compositionstart');
  await answer.press('Enter');
  await assertText(page, '#today-count', '0문항');
  assert.equal(await kana.textContent(), initialKana);
  await answer.dispatchEvent('compositionend');
  // A separate physical keypress lands after the composition commit event turn.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await assertText(page, '#today-count', '1문항');
  await assertText(page, '#feedback', '정답');
  assert.notEqual(await kana.textContent(), initialKana);
  assert.equal(await answer.inputValue(), '');
  assert.equal(await answer.evaluate((input) => document.activeElement === input), true);

  await answer.press('Control+z');
  await assertText(page, '#today-count', '0문항');
  assert.equal(await kana.textContent(), initialKana);
  assert.equal(await answer.inputValue(), answers.get(initialKana).primaryKo);
  await answer.fill('invalid-answer');
  await answer.press('Enter');
  await assertText(page, '#feedback', '오답');
  await assertText(page, '#today-count', '1문항');
  assert.equal(await kana.textContent(), initialKana);
  assert.equal(await answer.evaluate((input) => input.readOnly), true);
  await answer.press('Escape');
  assert.equal(await kana.textContent(), initialKana);
  await answer.press('Enter');
  await page.waitForFunction((previous) => document.querySelector('#question-kana').textContent !== previous, initialKana);
  const secondKana = await kana.textContent();
  await answer.press('Escape');
  await page.waitForFunction((previous) => document.querySelector('#question-kana').textContent !== previous, secondKana);
  await assertText(page, '#today-count', '1문항');

  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.locator('#settings-title').waitFor();
  await page.getByRole('button', { name: '전체 해제' }).click();
  await assertText(page, '#settings-count', '0문항');
  assert.equal(await page.locator('#start-quiz').isEnabled(), false);
  await page.locator('button[data-preset="hiragana"]').click();
  await assertText(page, '#settings-count', '104문항');
  await page.getByRole('button', { name: '기본 46자' }).click();
  await assertText(page, '#settings-count', '46문항');

  const downloaded = page.waitForEvent('download');
  await page.locator('#export-backup').click();
  const backup = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  assert.equal(backup.app, 'kana-loop');
  assert.equal(backup.appMeta.answeredCount, 1);
  assert.equal(Object.values(backup.dailyStats)[0].skipped, 1);
  assert.equal(Object.keys(backup.reviewQueue).length, 1);

  await page.locator('#reset-all').click();
  await page.getByRole('button', { name: '초기화', exact: true }).click();
  await assertText(page, '#today-count', '0문항');
  await page.locator('#backup-file').setInputFiles({
    name: 'test-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)),
  });
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '복원', exact: true }).click();
  await assertText(page, '#today-count', '1문항');
  await assertText(page, '#settings-count', '46문항');

  await page.locator('#start-quiz').click();
  await answer.waitFor();
  const other = await context.newPage();
  await other.goto(base);
  await assertText(other, '#global-status', '다른 탭에서 학습 중');
  await assertText(other, '#today-count', '1문항');
  await other.close();

  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await context.setOffline(true);
  const offlineReference = await context.newPage();
  await offlineReference.goto(base + '#answers');
  await offlineReference.getByRole('heading', { name: '가나 정답표' }).waitFor();
  await assertText(offlineReference, '#answer-count', '208자');
  await offlineReference.close();
  await page.reload();
  await answer.waitFor();
  await assertText(page, '#today-count', '1문항');
  const offlineKana = await kana.textContent();
  await answer.fill(answers.get(offlineKana).primaryRomaji.toUpperCase());
  await answer.press('Enter');
  await assertText(page, '#today-count', '2문항');

  await context.setOffline(false);
  updated = true;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready).waiting));
  await page.close();
  const afterUpdate = await context.newPage();
  await afterUpdate.goto(base);
  await afterUpdate.waitForFunction(() => document.title === 'Kana Loop • update');
  await assertText(afterUpdate, '#today-count', '2문항');
  assert.deepEqual(errors, []);
});
