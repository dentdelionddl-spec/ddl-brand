import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs, { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
const ADMIN = 'secret-admin';
const BRANDS = [
  { id: 'vivicate', name: 'VIVICATE', ko: '비비케이트', hue: 262, channels: ['자사몰'] },
  { id: 'newbrand', name: 'NEWBRAND', ko: '새 브랜드', hue: 100, channels: ['자사몰'] },
];
const brandsPage = () => ({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', properties: {
  '항목': { title: [{ plain_text: 'brands' }] },
  '값': { rich_text: [{ plain_text: JSON.stringify(BRANDS) }] },
} });

function startServer({ latency = 0, failTasks = 0 } = {}) {
  const state = { writes: [], failTasks, log: [] };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(new URL('../index.html', import.meta.url)));
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      if (latency) await new Promise((r) => setTimeout(r, latency));
      if (req.headers['x-admin-key'] !== ADMIN) return send(401, { message: '관리자 비밀번호가 필요합니다' });
      const db = String(body.database_id || '').replace(/-/g, '');
      state.log.push(body.action + ':' + db.slice(0, 8));
      if (['create', 'update', 'delete'].includes(body.action)) state.writes.push(body.action);
      if (body.action === 'clock' || body.action === 'ping') return send(200, { ok: true, now: new Date().toISOString() });
      if (body.action === 'realtime') return send(200, { realtime: false });
      if (body.action === 'changes') return send(200, { now: new Date().toISOString(), upserts: {}, deleted: {} });
      if (body.action === 'query') {
        // 업무 표(tasks)는 처음 몇 번 실패시킴
        if (db.startsWith('1b390d2a') && state.failTasks > 0) { state.failTasks--; return send(502, { message: 'upstream' }); }
        if (db.startsWith('46b8ab2d')) return send(200, { results: [brandsPage()] });
        return send(200, { results: [] });
      }
      return send(200, { results: [] });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

async function launch() {
  return puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}
async function open(browser, port, query = '') {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((k) => localStorage.setItem('ddl-brand-commerce-v1:admin', k), ADMIN);
  await page.reload({ waitUntil: 'domcontentloaded' });
  return page;
}
const sidebar = (page) => page.evaluate(() => [...document.querySelectorAll('.snav__l')].map((e) => e.textContent.trim()));

test('while loading the page shows a loader, never the default brands', { timeout: 30000, skip: !CHROME && 'chrome not found' }, async () => {
  const { server, port, state } = await startServer({ latency: 700 });
  const browser = await launch();
  try {
    const page = await open(browser, port);
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      seen.push(await sidebar(page));
      await new Promise((r) => setTimeout(r, 100));
    }
    // 서버에 있는 브랜드(NEWBRAND)가 보이기 전에 기본 브랜드(OOTN/RUHEL/USUEL)가 한 번도 나오면 안 됨
    for (const side of seen) assert.ok(!side.includes('OOTN') && !side.includes('RUHEL') && !side.includes('USUEL'), JSON.stringify(side));
    const last = seen[seen.length - 1];
    assert.ok(last.includes('NEWBRAND'), JSON.stringify(last));
    assert.deepEqual(state.writes, []);
  } finally { await browser.close(); await new Promise((r) => server.close(r)); }
});

test('a failed read shows retry state and writes nothing', { timeout: 30000, skip: !CHROME && 'chrome not found' }, async () => {
  const { server, port, state } = await startServer({ failTasks: 2 });
  const browser = await launch();
  try {
    const page = await open(browser, port);
    await page.waitForSelector('#loadretry', { timeout: 8000 });
    assert.deepEqual(await sidebar(page), []);
    await page.click('#loadretry');
    await page.waitForSelector('[data-brand="newbrand"]', { timeout: 15000 });
    assert.deepEqual(state.writes, []);
  } finally { await browser.close(); await new Promise((r) => server.close(r)); }
});
