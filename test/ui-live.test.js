import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

import { existsSync } from 'node:fs';
const CHROME = process.env.CHROME_PATH || ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
const ADMIN = 'secret-admin';
const ym = new Date().toISOString().slice(0, 7);
const salesId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function brandsPage() {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    properties: {
      '항목': { title: [{ plain_text: 'brands' }] },
      '값': { rich_text: [{ plain_text: JSON.stringify([
        { id: 'vivicate', name: 'VIVICATE', ko: '비비케이트', hue: 262, channels: ['자사몰'] },
        { id: 'ddl', name: 'DDL', ko: '팀 디디엘', hue: 280, channels: ['대행료'] },
      ]) }] },
    },
  };
}
function salesPage(goal) {
  return {
    id: salesId,
    properties: {
      '항목': { title: [{ plain_text: 'row' }] },
      '브랜드': { select: { name: 'VIVICATE' } },
      '월': { rich_text: [{ plain_text: ym }] },
      '채널': { select: { name: '자사몰' } },
      '목표': { number: goal },
      '실적': { number: 50000 },
      '로컬ID': { rich_text: [{ plain_text: 'sale1' }] },
    },
  };
}

const ID_KEYS = {
  '22c3381ad8e44f239be74fdd3243eba3': 'contents', '1b390d2a35db48d796e26edaa0834a6a': 'tasks',
  '5ca27a6560214303bc77b2da9e48ce02': 'sales', 'ddd18f71b6c9475abc59f74881cff410': 'products',
  '30a5544647d84123b4ad5e106c48c64e': 'plans', 'e33ee267da7d43fd86f72c28fa888114': 'costs',
  '21f72c37590f48dba49455f0c705b4ab': 'actions', '46b8ab2d1ddc47f7b5f8c0bfa4748ab9': 'config',
  'ae4c78c3a8324090b2617774d9ae3f01': 'refs', '691bda8c1aec4253964f2adda0e18c05': 'stats',
  'c0a051c168524e599f630c949a78f985': 'daily', 'b400cf41ae804765b1b15e3a4b004ba1': 'inquiries',
  '22b96ecfb203408295a3f8755c6935b6': 'traffic',
};

function startServer() {
  const state = { goal: 100000, editedAt: '2026-11-01T00:00:00.000Z' };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(new URL('../index.html', import.meta.url)));
      return;
    }
    if (req.method !== 'POST' || !req.url.startsWith('/api/notion')) {
      res.statusCode = 404;
      res.end('no');
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const key = req.headers['x-admin-key'];
      if (key !== ADMIN) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: '관리자 비밀번호가 필요합니다' }));
        return;
      }
      const db = String(body.database_id || '').replace(/-/g, '');
      const now = new Date().toISOString();
      let payload = { ok: true, now };
      if (body.action === 'clock' || body.action === 'ping') payload = { ok: true, now };
      else if (body.action === 'realtime') payload = { realtime: false, reason: 'test' };
      else if (body.action === 'bootstrap') {
        const results = {};
        for (const id of body.database_ids || []) {
          const key = ID_KEYS[String(id).replace(/-/g, '')];
          if (!key) continue;
          results[key] = key === 'config' ? [brandsPage()] : key === 'sales' ? [salesPage(state.goal)] : [];
        }
        payload = { now, results, errors: {} };
      }
      else if (body.action === 'query') {
        if (db.startsWith('46b8ab2d')) payload = { results: [brandsPage()] };
        else if (db.startsWith('5ca27a65')) payload = { results: [salesPage(state.goal)] };
        else payload = { results: [] };
      } else if (body.action === 'update') {
        state.goal = body.properties?.['목표']?.number ?? state.goal;
        state.editedAt = now;
        payload = { id: body.page_id };
      } else if (body.action === 'changes') {
        const since = body.since || '';
        const changed = state.editedAt > since;
        payload = {
          now,
          upserts: { sales: changed ? [salesPage(state.goal)] : [] },
          deleted: {},
        };
      } else payload = { results: [] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

async function openSales(browser, port) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/?poll=500`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((key) => localStorage.setItem('ddl-brand-commerce-v1:admin', key), ADMIN);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-brand="vivicate"]', { timeout: 8000 });
  await page.click('[data-brand="vivicate"]');
  await page.waitForSelector('[data-tab="sales"]');
  await page.click('[data-tab="sales"]');
  await page.waitForSelector('input[data-sale="자사몰"][data-f="goal"]');
  return page;
}

test('an edit shows immediately and reaches another tab without reload', { timeout: 60000, skip: !CHROME && 'chrome not found' }, async () => {
  const { server, port, state } = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const a = await openSales(browser, port);
    const b = await openSales(browser, port);
    const read = (page) => page.$eval('input[data-sale="자사몰"][data-f="goal"]', (el) => el.value);
    assert.equal(await read(a), '100,000');
    assert.equal(await read(b), '100,000');
    assert.equal(await a.$('#saveerr'), null);
    assert.equal(await a.$('.snav__sync'), null);

    await a.$eval('input[data-sale="자사몰"][data-f="goal"]', (el) => {
      el.value = '250000';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await a.waitForFunction(() => {
      const el = document.querySelector('input[data-sale="자사몰"][data-f="goal"]');
      return el && el.value === '250,000';
    }, { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(state.goal, 250000);

    await b.waitForFunction(() => {
      const el = document.querySelector('input[data-sale="자사몰"][data-f="goal"]');
      return el && el.value === '250,000';
    }, { timeout: 6000 });

    const fresh = await browser.newPage();
    await fresh.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await fresh.evaluate(() => localStorage.clear());
    await fresh.evaluate((key) => localStorage.setItem('ddl-brand-commerce-v1:admin', key), ADMIN);
    await fresh.reload({ waitUntil: 'domcontentloaded' });
    await fresh.waitForSelector('[data-brand="vivicate"]');
    await fresh.click('[data-brand="vivicate"]');
    await fresh.click('[data-tab="sales"]');
    await fresh.waitForSelector('input[data-sale="자사몰"][data-f="goal"]');
    assert.equal(await read(fresh), '250,000');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
