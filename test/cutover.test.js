import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { createHmac } from 'node:crypto';
import { columnsFromProperties, rowToPage, TABLES } from '../lib/pages.js';
import { authHeaders, signJwt, storagePathFromId } from '../lib/supabase.js';
import handler, { resetAuthCache } from '../api/notion.js';
import schedule from '../api/schedule.js';

/* 팀원 구글 로그인 흉내: /auth/v1/user는 팀원 이메일을, app_settings에는 members 행을 덧붙임 */
const TEAM = { authorization: 'Bearer team-token' };
let __innerFetch = null;
const __teamFetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/auth/v1/user')) {
    const ok = String(opts.headers?.Authorization || '') === 'Bearer team-token';
    return { ok, status: ok ? 200 : 401, async text() { return JSON.stringify(ok ? { email: 'team@ddl.kr' } : {}); }, async json() { return ok ? { email: 'team@ddl.kr' } : {}; } };
  }
  const r = await __innerFetch(url, opts);
  if (u.includes('/rest/v1/app_settings') && (!opts.method || opts.method === 'GET') && r.ok) {
    let rows = []; try { rows = JSON.parse(await r.text()); } catch {}
    if (!Array.isArray(rows)) rows = [];
    rows.push({ notion_page_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 항목: 'members', 값: JSON.stringify([{ email: 'team@ddl.kr', name: '승호' }]) });
    const text = JSON.stringify(rows);
    return { ok: true, status: 200, async text() { return text; }, async json() { return rows; } };
  }
  return r;
};
Object.defineProperty(globalThis, 'fetch', { configurable: true, get() { return __teamFetch; }, set(v) { __innerFetch = v; } });


const SQL = fs.readFileSync(new URL('../supabase/migrations/20261128143000_ddl_brand_supabase_cutover.sql', import.meta.url), 'utf8');
const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function resMock() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
  return res;
}

function req(body, headers = {}) {
  return { method: 'POST', headers: { origin: 'https://ddl-brand.vercel.app', ...headers }, body };
}

test('secret keys are not sent as Bearer', () => {
  const modern = authHeaders('sb_secret_example');
  assert.equal(modern.apikey, 'sb_secret_example');
  assert.equal(modern.Authorization, undefined);
  const legacy = authHeaders('eyJabc.def.ghi');
  assert.equal(legacy.Authorization, 'Bearer eyJabc.def.ghi');
});

test('content properties round-trip into columns', () => {
  const spec = TABLES.contents;
  const props = {
    '제목': { title: [{ text: { content: '입고' } }] },
    '브랜드': { select: { name: 'VIVICATE' } },
    '유형': { select: { name: '제품 입고' } },
    '날짜': { date: { start: '2026-11-02', end: '2026-11-04' } },
    '완료': { checkbox: false },
    '로컬ID': { rich_text: [{ text: { content: 'abc' } }] },
  };
  const cols = columnsFromProperties(spec, props, null);
  assert.equal(cols['제목'], '입고');
  assert.equal(cols['브랜드'], 'VIVICATE');
  assert.equal(cols['날짜_start'], '2026-11-02');
  assert.equal(cols['날짜_end'], '2026-11-04');
  assert.equal(cols['완료'], false);
  const page = rowToPage(spec, { notion_page_id: '11111111-1111-4111-8111-111111111111', ...cols, properties: props });
  assert.equal(page.properties['제목'].title[0].plain_text, '입고');
  assert.equal(page.properties['날짜'].date.end, '2026-11-04');
  assert.equal(page.archived, false);
});

test('task brand is stored on both columns', () => {
  const cols = columnsFromProperties(TABLES.tasks, {
    Task: { title: [{ text: { content: '촬영' } }] },
    Brand: { select: { name: 'VIVICATE' } },
    Status: { status: { name: 'To do' } },
  }, null);
  assert.equal(cols.task, '촬영');
  assert.equal(cols.brand, 'VIVICATE');
  assert.equal(cols['브랜드'], 'VIVICATE');
  assert.equal(cols.status, 'To do');
});

test('SQL is brand-only, enables realtime RLS, and does not touch the dashboard', () => {
  for (const name of ['content_calendar', 'weekly_plan', 'daily_sales', 'app_settings', 'threads_performance', 'brand_references']) {
    assert.match(SQL, new RegExp(name));
  }
  assert.match(SQL, /security_invoker = true/);
  assert.match(SQL, /brand_realtime/);
  assert.match(SQL, /FOR SELECT TO brand_realtime/);
  assert.match(SQL, /supabase_realtime ADD TABLE/);
  assert.match(SQL, /deleted_at/);
  assert.match(SQL, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  for (const banned of ['ddl_projects', 'scope_modules', 'hermes_', 'household_', 'ddl_company_content_calendar']) {
    assert.equal(SQL.includes(banned), false, banned);
  }
});

test('the page is a live app, not a Notion sync client', () => {
  assert.equal(HTML.includes('snav__sync'), false);
  assert.equal(HTML.includes('노션으로 올리기'), false);
  assert.equal(HTML.includes('노션에서 내려받기'), false);
  assert.equal(HTML.includes('노션 자동 동기화'), false);
  assert.equal(HTML.includes('노션에 '), false);
  assert.match(HTML, /saveerr/);
  assert.match(HTML, /postgres_changes/);
  assert.match(HTML, /schema:'notion'/);
  assert.match(HTML, /POLL_MS/);
  assert.match(HTML, /: 5000/);
  assert.equal(HTML.includes('liveRefresh'), false);
  assert.equal(HTML.includes('if(document.hidden) return'), false);
  assert.match(HTML, /id="loadgate"/);
  assert.equal(HTML.includes('store.set(KEY,JSON.stringify(DB))'), false);
  assert.equal(HTML.includes("store.set(KEY, JSON.stringify(DB))"), false);
});

test('team member create writes Supabase and does not send the service key as Bearer', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    process.env.SUPABASE_JWT_SECRET = 'jwt-secret';
  resetAuthCache();
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (opts.method === 'POST') {
      return jsonResponse([{ ...body, notion_page_id: body.notion_page_id }]);
    }
    return jsonResponse([]);
  };
  const res = resMock();
  await handler(req({
    action: 'create',
    database_id: TABLES.contents.id,
    properties: {
      '제목': { title: [{ text: { content: '릴스' } }] },
      '브랜드': { select: { name: 'VIVICATE' } },
      '날짜': { date: { start: '2026-11-28' } },
    },
  }, TEAM), res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.id);
  const post = calls.find((c) => c.opts.method === 'POST');
  assert.equal(post.opts.headers.apikey, 'sb_secret_test');
  assert.equal(post.opts.headers.Authorization, undefined);
  assert.equal(JSON.parse(post.opts.body)['제목'], '릴스');
  assert.equal(post.url.includes('content_calendar'), true);
});

test('realtime token is short-lived, read-only, and scoped', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    process.env.SUPABASE_JWT_SECRET = 'jwt-secret';
  resetAuthCache();
  global.fetch = async () => jsonResponse([]);
  const res = resMock();
  await handler(req({ action: 'realtime' }, TEAM), res);
  assert.equal(res.body.realtime, true);
  assert.equal(res.body.token.includes('sb_secret_test'), false);
  const payload = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'brand_realtime');
  assert.equal(payload.brand_scope, 'all');
  assert.ok(payload.exp - payload.iat <= 300);
  const expectSig = createHmac('sha256', 'jwt-secret')
    .update(res.body.token.split('.').slice(0, 2).join('.'))
    .digest('base64url');
  assert.equal(res.body.token.split('.')[2], expectSig);
  const again = signJwt(payload, 'jwt-secret');
  assert.equal(again.split('.')[2], expectSig);
});

test('missing jwt secret falls back instead of minting a service token', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    delete process.env.SUPABASE_JWT_SECRET;
  resetAuthCache();
  global.fetch = async () => jsonResponse([]);
  const res = resMock();
  await handler(req({ action: 'realtime' }, TEAM), res);
  assert.equal(res.body.realtime, false);
  assert.equal(res.body.token, undefined);
});

test('share link can read only its brand and cannot write', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    resetAuthCache();
  global.fetch = async (url) => {
    if (String(url).includes('app_settings')) {
      return jsonResponse([{
        notion_page_id: '22222222-2222-4222-8222-222222222222',
        '항목': 'brands',
        '값': JSON.stringify([{ id: 'vivicate', name: 'VIVICATE', shareKey: 'share-key' }]),
        properties: {},
      }]);
    }
    return jsonResponse([
      row('VIVICATE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      row('AUBE SEOUL', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    ]);
  };
  const read = resMock();
  await handler(req({ action: 'query', database_id: TABLES.contents.id }, { 'x-share-key': 'share-key' }), read);
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.results.length, 1);
  assert.equal(read.body.results[0].properties['브랜드'].select.name, 'VIVICATE');
  const write = resMock();
  await handler(req({ action: 'create', database_id: TABLES.contents.id, properties: {} }, { 'x-share-key': 'share-key' }), write);
  assert.equal(write.statusCode, 401);
});

test('changes since returns only newer and deleted rows', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    resetAuthCache();
  let seen = '';
  global.fetch = async (url) => {
    seen = String(url);
    return jsonResponse([
      { ...row('VIVICATE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), deleted_at: '2026-11-28T01:00:00.000Z', last_edited_time: '2026-11-28T01:00:00.000Z' },
    ]);
  };
  const res = resMock();
  await handler(req({ action: 'changes', since: '2026-11-28T00:00:00.000Z' }, TEAM), res);
  assert.equal(res.statusCode, 200);
  assert.ok(seen.includes('last_edited_time.gt'));
  assert.ok(Array.isArray(res.body.deleted.contents));
  assert.equal(res.body.deleted.contents.length, 1);
  assert.equal(res.body.upserts.contents.length, 0);
  assert.ok(res.body.now);
  /* 다음 기준 시각은 읽기 시작보다 앞(몇 초 겹침)이어야 읽는 도중의 수정이 빠지지 않음 */
  assert.ok(Date.parse(res.body.now) <= Date.now() - 3000);
});

test('adding and removing attachments keeps migrated file paths', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    resetAuthCache();
  const cal = 'notion-files/content_calendar/page1111/photo.jpg';
  const plan = 'notion-files/content_plans/page1111/plan.png';
  const added = 'ddl-brand/cccccccc-cccc-4ccc-8ccc-cccccccccccc/new.jpg';
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), method: opts.method || 'GET', body });
    if ((opts.method || 'GET') === 'GET') {
      return jsonResponse([{
        notion_page_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '제목': '일정',
        '브랜드': 'VIVICATE',
        files_storage: [{ path: cal, name: 'photo.jpg' }, { path: plan, name: 'plan.png' }],
        properties: {},
      }]);
    }
    return jsonResponse([{ ...body, notion_page_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]);
  };
  const files = (paths) => ({
    files: paths.map((path) => ({ name: path.split('/').pop(), type: 'file_upload', file_upload: { id: path } })),
  });
  const pageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const add = resMock();
  await handler(req({
    action: 'update',
    page_id: pageId,
    properties: { '첨부': files([cal, plan, added]) },
  }, TEAM), add);
  assert.equal(add.statusCode, 200);
  const stored = () => calls.filter((c) => c.method === 'PATCH').at(-1).body.files_storage.map((f) => f.path);
  assert.deepEqual(stored(), [
    cal,
    plan,
    'notion-files/' + added,
  ]);

  const remove = resMock();
  await handler(req({
    action: 'update',
    page_id: pageId,
    properties: { '첨부': files([plan]) },
  }, TEAM), remove);
  assert.equal(remove.statusCode, 200);
  assert.deepEqual(stored(), [plan]);

  const clear = resMock();
  await handler(req({
    action: 'update',
    page_id: pageId,
    properties: { '첨부': { files: [] } },
  }, TEAM), clear);
  assert.equal(clear.statusCode, 200);
  assert.deepEqual(stored(), []);
  assert.equal(storagePathFromId('notion-files/content_calendar/../secret.jpg'), null);
  assert.equal(storagePathFromId('other/page/a.jpg'), null);
  assert.match(HTML, /id:f\.path/);
  assert.equal(HTML.includes('설정 · 동기화'), false);
  assert.match(HTML, /brandtitle">설정</);
});

test('public schedule reads vivicate rows from Supabase', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('weekly_plan')) {
      return jsonResponse([{
        notion_page_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        task: '촬영',
        brand: 'VIVICATE',
        '브랜드': 'VIVICATE',
        status: 'To do',
        due_start: '2026-12-01',
        '영역': '모객',
        properties: {},
      }]);
    }
    return jsonResponse([{
      notion_page_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '제목': '입고',
      '브랜드': 'VIVICATE',
      '유형': '제품 입고',
      '날짜_start': '2026-12-02',
      '완료': false,
      properties: {},
    }]);
  };
  const res = resMock();
  await schedule({ method: 'GET', headers: {}, query: { brand: 'vivicate' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.items.find((i) => i.kind === 'schedule').title, '입고');
  assert.equal(res.body.items.find((i) => i.kind === 'task').title, '촬영');
});

function row(brand, id) {
  return {
    notion_page_id: id,
    '제목': '일정',
    '브랜드': brand,
    '날짜_start': '2026-11-01',
    '완료': false,
    properties: {},
  };
}
function jsonResponse(body, status = 200) {
  return {
    ok: status < 400,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

test('bootstrap reads every requested table in one call and keeps the safe `now`', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    resetAuthCache();
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/rest/v1/weekly_plan')) return jsonResponse([row('VIVICATE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]);
    if (u.includes('/rest/v1/content_calendar')) return jsonResponse([row('AUBE SEOUL', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')]);
    return jsonResponse([]);
  };
  const res = resMock();
  await handler(req({ action: 'bootstrap', database_ids: [TABLES.tasks.id, TABLES.contents.id, TABLES.config.id, 'not-a-table'] }, TEAM), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.results).sort(), ['config', 'contents', 'tasks']);
  assert.equal(res.body.results.tasks.length, 1);
  assert.deepEqual(res.body.errors, {});
  assert.ok(Date.parse(res.body.now) <= Date.now() - 3000, 'now must be earlier than the reads');
  assert.ok(seen.length >= 3);
  assert.ok(res.headers['Server-Timing']);
});

test('bootstrap: one failing table is reported, not hidden, and scoped links cannot read other tables', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    resetAuthCache();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/weekly_plan')) return jsonResponse({ message: 'boom' }, 500);
    return jsonResponse([]);
  };
  const res = resMock();
  await handler(req({ action: 'bootstrap', database_ids: [TABLES.tasks.id, TABLES.contents.id] }, TEAM), res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.errors.tasks);
  assert.equal(res.body.results.tasks, undefined);
  assert.ok(res.body.results.contents);

  resetAuthCache();
  const brands = [{ id: 'vivicate', name: 'VIVICATE', ko: '비비케이트', channels: [] }];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/app_settings')) {
      return jsonResponse([{ notion_page_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '항목': 'brands', '값': JSON.stringify(brands), properties: {} }]);
    }
    return jsonResponse([]);
  };
  const embed = resMock();
  await handler(req({ action: 'bootstrap', database_ids: [TABLES.tasks.id, TABLES.products.id, TABLES.costs.id] }, { 'x-embed-brand': 'vivicate' }), embed);
  assert.equal(embed.statusCode, 200);
  assert.deepEqual(Object.keys(embed.body.results), ['tasks']); /* embed may read tasks only of these */
});

test('large responses are gzipped when the browser accepts it', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
    resetAuthCache();
  const many = Array.from({ length: 80 }, (_, i) => row('VIVICATE', `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`));
  global.fetch = async () => jsonResponse(many);
  const res = resMock();
  let sent = null;
  res.end = (buf) => { sent = buf; return res; };
  await handler(req({ action: 'bootstrap', database_ids: [TABLES.tasks.id] }, { ...TEAM, 'accept-encoding': 'gzip, br' }), res);
  assert.equal(res.headers['Content-Encoding'], 'gzip');
  const { gunzipSync } = await import('node:zlib');
  const parsed = JSON.parse(gunzipSync(sent).toString('utf8'));
  assert.equal(parsed.results.tasks.length, 80);
  assert.ok(sent.length < JSON.stringify(parsed).length / 3);
});

test('function region is Seoul (next to the Supabase project) and config stays light', () => {
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(vercel.regions, ['icn1']);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
});

test('admin password is no longer accepted; non-member Google accounts are refused', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  process.env.ADMIN_KEY = 'admin-secret';
  resetAuthCache();
  global.fetch = async () => jsonResponse([]);
  const old = resMock();
  await handler(req({ action: 'bootstrap' }, { 'x-admin-key': 'admin-secret' }), old);
  assert.equal(old.statusCode, 401);
  const stranger = resMock();
  await handler(req({ action: 'bootstrap' }, { authorization: 'Bearer someone-else' }), stranger);
  assert.equal(stranger.statusCode, 401);
  const team = resMock();
  await handler(req({ action: 'whoami' }, TEAM), team);
  assert.equal(team.statusCode, 200);
  assert.equal(team.body.member, '승호');
  delete process.env.ADMIN_KEY;
});
