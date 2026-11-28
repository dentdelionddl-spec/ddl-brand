import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

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

test('an edit shows immediately and reaches another tab without reload', { timeout: 60000 }, async () => {
  const { server, port, state } = await startServer();
  const browser = await puppeteer.launch({
    executablePath: '/usr/local/bin/google-chrome',
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
