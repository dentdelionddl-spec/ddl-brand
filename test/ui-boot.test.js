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

const ID_KEYS = {
  '22c3381ad8e44f239be74fdd3243eba3': 'contents', '1b390d2a35db48d796e26edaa0834a6a': 'tasks',
  '5ca27a6560214303bc77b2da9e48ce02': 'sales', 'ddd18f71b6c9475abc59f74881cff410': 'products',
  '30a5544647d84123b4ad5e106c48c64e': 'plans', 'e33ee267da7d43fd86f72c28fa888114': 'costs',
  '21f72c37590f48dba49455f0c705b4ab': 'actions', '46b8ab2d1ddc47f7b5f8c0bfa4748ab9': 'config',
  'ae4c78c3a8324090b2617774d9ae3f01': 'refs', '691bda8c1aec4253964f2adda0e18c05': 'stats',
  'c0a051c168524e599f630c949a78f985': 'daily', 'b400cf41ae804765b1b15e3a4b004ba1': 'inquiries',
  '22b96ecfb203408295a3f8755c6935b6': 'traffic',
};

function startServer({ latency = 0, failTasks = 0, noBootstrap = false, noConfig = false, bootLatency = 0 } = {}) {
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
      if (body.action === 'bootstrap') {
        if (noBootstrap) return send(400, { message: '모르는 action: bootstrap' });
        if (bootLatency) await new Promise((r) => setTimeout(r, bootLatency));
        if (state.failTasks > 0) { state.failTasks--; return send(502, { message: 'upstream' }); }
        const results = {};
        for (const id of body.database_ids || []) {
          const key = ID_KEYS[String(id).replace(/-/g, '')];
          if (key) results[key] = key === 'config' ? (noConfig ? [] : [brandsPage()]) : [];
        }
        return send(200, { now: new Date().toISOString(), results, errors: {} });
      }
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

const snapOf = (page) => page.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.includes(':snap:'));
  return k ? JSON.parse(localStorage.getItem(k)) : null;
});

test('second visit shows the cached server data at once (never defaults), locks writes, then swaps in fresh data', { timeout: 40000, skip: !CHROME && 'chrome not found' }, async () => {
  const { server, port, state } = await startServer({ bootLatency: 2500 });
  const browser = await launch();
  try {
    const page = await open(browser, port);
    await page.waitForSelector('[data-brand="newbrand"]', { timeout: 15000 });
    await page.waitForFunction(() => Object.keys(localStorage).some((x) => x.includes(':snap:')), { timeout: 8000 });
    const snap = await snapOf(page);
    assert.deepEqual(snap.brands.map((b) => b.name), ['VIVICATE', 'NEWBRAND']);
    assert.ok(!JSON.stringify(snap).includes('RUHEL') && !JSON.stringify(snap).includes('OOTN'));
    assert.deepEqual(state.writes, []);

    /* 두 번째 방문: 서버가 2.5초 늦어도 캐시가 바로 보여야 함 */
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-brand="newbrand"]', { timeout: 1500 });
    assert.ok(Date.now() - t0 < 1500, 'cached data should paint before the server answers');
    const during = await page.evaluate(() => ({ state: LOAD.state, locked: document.body.classList.contains('syncing'), pill: !!document.getElementById('syncpill'),
      side: [...document.querySelectorAll('.snav__l')].map((e) => e.textContent.trim()) }));
    assert.equal(during.state, 'cached');
    assert.equal(during.locked, true);
    assert.equal(during.pill, true);
    assert.ok(!during.side.includes('OOTN') && !during.side.includes('RUHEL') && !during.side.includes('USUEL'));
    /* 캐시 상태에서는 쓰기가 막혀 있음 */
    assert.equal(await page.evaluate(() => { queueWrite(); return 'ok'; }), 'ok');
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(state.writes, []);

    await page.waitForFunction(() => LOAD.state === 'ready', { timeout: 10000 });
    assert.equal(await page.evaluate(() => !document.getElementById('syncpill') && !document.body.classList.contains('syncing')), true);
  } finally { await browser.close(); await new Promise((r) => server.close(r)); }
});

test('a snapshot is never saved when the server has no brand list (defaults stay out of the cache)', { timeout: 30000, skip: !CHROME && 'chrome not found' }, async () => {
  const { server, port } = await startServer({ noConfig: true });
  const browser = await launch();
  try {
    const page = await open(browser, port);
    await page.waitForFunction(() => LOAD.state === 'ready', { timeout: 15000 });
    await page.evaluate(() => saveSnap());
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(await snapOf(page), null);
  } finally { await browser.close(); await new Promise((r) => server.close(r)); }
});

test('a snapshot with default brands or an old version is ignored', { timeout: 30000, skip: !CHROME && 'chrome not found' }, async () => {
  const { server, port } = await startServer({ bootLatency: 1500 });
  const browser = await launch();
  try {
    const page = await open(browser, port);
    await page.waitForFunction(() => LOAD.state === 'ready', { timeout: 15000 });
    await page.evaluateOnNewDocument(() => {
      const bad = { v: 99, t: Date.now(), brands: [{ id: 'ootn', name: 'OOTN' }] };
      for (const k of ['contents', 'tasks', 'sales', 'products', 'plans', 'costs', 'actions', 'refs', 'stats', 'daily']) bad[k] = [];
      localStorage.setItem('ddl-brand-commerce-v1:snap:admin', JSON.stringify(bad));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const st = await page.evaluate(() => ({ state: LOAD.state, side: document.querySelectorAll('.snav__l').length }));
    assert.equal(st.state, 'loading');
    assert.equal(st.side, 0);
    await page.waitForFunction(() => LOAD.state === 'ready', { timeout: 15000 });
  } finally { await browser.close(); await new Promise((r) => server.close(r)); }
});

test('an older server without bootstrap still loads (per-table fallback)', { timeout: 30000, skip: !CHROME && 'chrome not found' }, async () => {
  const { server, port, state } = await startServer({ noBootstrap: true });
  const browser = await launch();
  try {
    const page = await open(browser, port);
    await page.waitForSelector('[data-brand="newbrand"]', { timeout: 15000 });
    assert.deepEqual(state.writes, []);
    assert.ok(state.log.some((x) => x.startsWith('query:')));
  } finally { await browser.close(); await new Promise((r) => server.close(r)); }
});
