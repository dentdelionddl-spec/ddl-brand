import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  buildContentInsights,
  collectionStamp,
  matchesPostQuery,
  pageFromPerformanceRecord,
  parsePerformanceRow,
  parsePerformanceSnapshot,
  rowMatchesBrand,
  summarizePerformance,
  trendPosition,
} from '../lib/threads-performance.js';
import {
  activeBrands,
  buildPostSnapshot,
  decideTokenRefresh,
  fingerprint,
  redactSecrets,
  sinceDate,
} from '../lib/threads-collector.js';
import { runJob } from '../supabase/functions/threads-collector/job.js';
import handler from '../api/threads-performance.js';
import { resetAuthCache } from '../api/notion.js';

const rich = (value) => ({ rich_text: value ? [{ plain_text: value }] : [] });
const title = (value) => ({ title: value ? [{ plain_text: value }] : [] });
const num = (value) => ({ number: value });

test('brand labels and screen filters follow the source brand field', () => {
  const row = parsePerformanceRow({
    id: 'page-1',
    properties: {
      제목: title('제목'),
      본문: rich('본문'),
      브랜드: { select: { name: '공장(용저우)' } },
      조회수: num(120),
      좋아요: num(5),
      댓글: num(2),
      '인사이트 관측시각': { date: { start: '2026-11-27T07:30:20+09:00' } },
      '관측 경과시간': num(50),
    },
  });
  assert.equal(row.brandLabel, '미싱맨');
  assert.equal(row.metrics.views, 120);
  assert.equal(row.milestones.t2.status, 'complete');
  assert.equal(rowMatchesBrand(row, { id: 'factory', name: '공장', ko: '용저우 공장' }), true);
  assert.equal(rowMatchesBrand(row, { id: 'aube', name: 'AUBE SEOUL', ko: '오브서울' }), false);
  const aube = parsePerformanceRow({
    id: 'page-a',
    properties: { 제목: title('글'), 브랜드: { select: { name: 'AUBE SEOUL' } }, 조회수: num(3) },
  });
  assert.equal(aube.brandLabel, '오브서울');
  assert.equal(rowMatchesBrand(aube, { id: 'aube', name: 'AUBE SEOUL' }), true);
});

test('cumulative snapshot overrides latest metrics and keeps the series', () => {
  const snapshot = JSON.stringify({
    v: 2,
    scope: 'post_lifetime',
    account: 'excluded',
    pid: 'post-2',
    as_of: '2026-11-27T07:30:20+09:00',
    latest: { at: '2026-11-27T07:30:20+09:00', age_h: 20.63, m: { v: 200, l: 5, r: 1 } },
    ms: { t7: { s: 'c', at: '2026-11-27T07:30:20+09:00', age_h: 72, m: { v: 180 } } },
    o: [[10, 40, 1, 0], [20.63, 200, 5, 1]],
  });
  const row = parsePerformanceRow(pageFromPerformanceRecord({
    notion_page_id: 'page-2',
    제목: '제목',
    브랜드: 'AUBE SEOUL',
    로컬id: 'post-2',
    조회수: 10,
    발행일_start: '2026-11-26',
    누적_성과_스냅샷: snapshot,
    userdefined_url: 'https://www.threads.com/@aube_seoul/post/abc',
  }));
  assert.equal(row.metrics.views, 200);
  assert.equal(row.milestones.t7.metrics.views, 180);
  assert.deepEqual(row.series.map((item) => item.metrics.views), [40, 200]);
  assert.equal(row.publishedAt, '2026-11-26');
  assert.equal(row.latestObservedAt, '2026-11-27T07:30:20+09:00');
  assert.equal(parsePerformanceSnapshot('not json'), null);
  assert.equal(parsePerformanceSnapshot('{"v":1}'), null);
});

test('a snapshot for another post is ignored', () => {
  const snapshot = JSON.stringify({
    v: 1, scope: 'post_lifetime', account: 'excluded', pid: 'DIFFERENT',
    latest: { m: { v: 999 } }, ms: {},
  });
  const row = parsePerformanceRow({
    id: 'page-mismatch',
    properties: {
      제목: title('제목'),
      로컬ID: rich('POST-1'),
      조회수: num(120),
      '누적 성과 스냅샷': rich(snapshot),
    },
  });
  assert.equal(row.metrics.views, 120);
  assert.equal(row.snapshotStatus, 'post_id_mismatch');
});

test('summary median and collection stamp', () => {
  const rows = [
    { metrics: { views: 10, likes: 1, replies: 2 }, milestones: {}, latestObservedAt: '2026-11-26T22:00:00Z', publishedAt: '2026-11-25' },
    { metrics: { views: 30, likes: 3, replies: 4 }, milestones: {}, latestObservedAt: '2026-11-27T07:30:20+09:00', publishedAt: '2026-11-26' },
  ];
  const summary = summarizePerformance(rows);
  assert.equal(summary.views, 40);
  assert.equal(summary.medianViews, 20);
  assert.equal(summary.likes + summary.replies, 10);
  assert.equal(summary.latestPublishedAt, '2026-11-26');
  const fromLog = collectionStamp(rows, [{ status: 'ok', finished_at: '2026-11-27T07:30:20+09:00', job: 'archive', posts: 212 }]);
  assert.equal(fromLog.source, 'log');
  assert.equal(fromLog.collectedAt, '2026-11-27T07:30:20+09:00');
  const fromRows = collectionStamp(rows, null);
  assert.equal(fromRows.source, 'observations');
  assert.equal(fromRows.collectedAt, '2026-11-27T07:30:20+09:00');
});

test('content insight and post search', () => {
  const makeRow = ({ id, question, views, replies }) => ({
    id,
    body: `${question ? '어떤 공장이 좋을까?' : '나는 답변부터 봐.'}\n두 번째 줄\n세 번째 줄\n네 번째 줄`,
    hasImage: question,
    metrics: { views, replies },
    milestones: { t7: { status: 'complete', metrics: { views, replies } } },
  });
  const rows = [
    ...[1, 2, 3].map((id) => makeRow({ id: `q${id}`, question: true, views: 300, replies: 15 })),
    ...[1, 2, 3].map((id) => makeRow({ id: `s${id}`, question: false, views: 100, replies: 1 })),
  ];
  const insight = buildContentInsights(rows).find((item) => item.key === 'question_open');
  assert.equal(insight.reach.multiple, 3);
  assert.equal(matchesPostQuery({ body: '공장 답변', brandLabel: '미싱맨' }, '미싱맨'), true);
  assert.equal(matchesPostQuery({ body: '공장 답변', brandLabel: '미싱맨' }, '오브서울'), false);
  assert.equal(trendPosition(20, 20, 72), 0);
  assert.equal(trendPosition(72, 20, 72), 1);
});

function resMock() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end(buf) { this.raw = buf; return this; },
  };
}

const performanceRow = (brand, id, views) => ({
  notion_page_id: id,
  제목: '제목',
  본문: '본문',
  브랜드: brand,
  로컬id: id,
  조회수: views,
  좋아요: 2,
  댓글: 1,
  발행일_start: '2026-11-26',
  누적_성과_스냅샷: JSON.stringify({
    v: 2, scope: 'post_lifetime', account: 'excluded', pid: id,
    as_of: '2026-11-27T07:30:20+09:00',
    latest: { at: '2026-11-27T07:30:20+09:00', age_h: 20, m: { v: views, l: 2, r: 1 } },
    ms: { t2: { s: 'c', m: { v: views } } },
    o: [[8, 1, 0, 0], [20, views, 2, 1]],
  }),
});

test('read endpoint uses the admin key, filters a brand, and falls back when the log is missing', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  process.env.ADMIN_KEY = 'admin-secret';
  resetAuthCache();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/threads_collector_runs')) {
      return { ok: false, status: 404, statusText: 'missing', async text() { return JSON.stringify({ message: 'relation does not exist' }); } };
    }
    if (u.includes('/rest/v1/threads_performance')) {
      return { ok: true, status: 200, async text() { return JSON.stringify([
        performanceRow('AUBE SEOUL', '11111111-1111-4111-8111-111111111111', 200),
        performanceRow('공장(용저우)', '22222222-2222-4222-8222-222222222222', 46),
      ]); } };
    }
    return { ok: true, status: 200, async text() { return '[]'; } };
  };
  const denied = resMock();
  await handler({ method: 'POST', headers: {}, body: { brandId: 'aube' } }, denied);
  assert.equal(denied.statusCode, 401);

  const res = resMock();
  await handler({ method: 'POST', headers: { 'x-admin-key': 'admin-secret' }, body: { brandId: 'aube', brandName: 'AUBE SEOUL' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.posts, 1);
  assert.equal(res.body.summary.views, 200);
  assert.equal(res.body.brandLabel, '오브서울');
  assert.equal(res.body.rows[0].brandLabel, '오브서울');
  assert.equal(res.body.collectedAtSource, 'observations');
  assert.equal(res.body.collectedAt, '2026-11-27T07:30:20+09:00');
  assert.equal(res.body.latestPublishedAt, '2026-11-26');
  assert.equal(JSON.stringify(res.body).includes('notion'), false);
});

test('share link only receives that brand, and a collector log wins the stamp', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  process.env.ADMIN_KEY = 'admin-secret';
  resetAuthCache();
  const brands = [{ id: 'factory', name: '공장', ko: '용저우 공장', shareKey: 'share-secret' }];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/app_settings')) {
      return { ok: true, status: 200, async text() { return JSON.stringify([{
        notion_page_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        항목: 'brands',
        값: JSON.stringify(brands),
      }]); } };
    }
    if (u.includes('/rest/v1/threads_collector_runs')) {
      return { ok: true, status: 200, async text() { return JSON.stringify([{
        job: 'archive', status: 'ok', finished_at: '2026-11-27T07:30:20+09:00', posts: 212, error: '',
      }]); } };
    }
    if (u.includes('/rest/v1/threads_performance')) {
      const rows = [performanceRow('AUBE SEOUL', '11111111-1111-4111-8111-111111111111', 200)];
      for (let i = 0; i < 40; i++) {
        rows.push(performanceRow('공장(용저우)', `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`, 46));
      }
      return { ok: true, status: 200, async text() { return JSON.stringify(rows); } };
    }
    return { ok: true, status: 200, async text() { return '[]'; } };
  };
  const res = resMock();
  let sent = null;
  res.end = (buf) => { sent = buf; return res; };
  await handler({
    method: 'POST',
    headers: { 'x-share-key': 'share-secret', 'accept-encoding': 'gzip' },
    body: { brandId: 'aube' },
  }, res);
  assert.equal(res.headers['Content-Encoding'], 'gzip');
  const body = JSON.parse(gunzipSync(sent).toString('utf8'));
  assert.equal(body.rows.length, 40);
  assert.equal(body.rows[0].brand, '공장(용저우)');
  assert.equal(body.collectedAtSource, 'log');
  assert.equal(body.collector.lastSuccess.job, 'archive');
});

test('collector keeps arikiv off, refreshes tokens before 14 days, and writes posts without publishing', async () => {
  assert.deepEqual(activeBrands(new Date('2026-11-28T00:00:00Z')).map((brand) => brand.name), ['aube-seoul', 'missingman']);
  assert.equal(sinceDate(new Date('2026-11-28T00:00:00Z')), '2026-10-27');
  const now = new Date('2026-11-28T00:00:00Z');
  const fresh = decideTokenRefresh({ name: 'aube-seoul' }, 'token-a', now, {
    token_fingerprint: fingerprint('token-a'),
    expires_at: '2026-12-20T00:00:00Z',
  }, null, null);
  assert.equal(fresh.status, '정상');
  const deferred = decideTokenRefresh({ name: 'aube-seoul' }, 'token-a', now, { token_fingerprint: fingerprint('token-a') }, null, 'nope token-a');
  assert.match(deferred.status, /보류/);
  assert.equal(deferred.record.refresh_error.includes('token-a'), false);
  assert.equal(redactSecrets('failed token-a', ['token-a']).includes('token-a'), false);

  const applied = [];
  const runs = [];
  const db = {
    async readToken() { return 'secret-token'; },
    async readTokenState() { return null; },
    async writeToken() {},
    async readMetrics() { return []; },
    async readAccountSnapshots() { return [{ collected_at: '2026-11-20T00:00:00Z', followers_count: 100 }]; },
    async apply(payload) { applied.push(payload); },
    async insertRun(run) { runs.push(run); },
  };
  const api = {
    async fetchPosts() {
      return [{ id: 'p1', text: '본문', timestamp: '2026-11-25T00:00:00Z', permalink: 'https://www.threads.com/p/1', media_type: 'TEXT' }];
    },
    async attachInsights(posts) { posts[0].views = 12; posts[0].likes = 1; posts[0].replies = 0; posts[0].reposts = 0; posts[0].quotes = 0; posts[0].shares = 0; },
    async fetchAccountInsights() { return { metrics: { followers_count: 110, views: 8 } }; },
  };
  const result = await runJob('archive', { db, api, now, pauseMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.posts, 2);
  assert.equal(applied.length, 2);
  assert.equal(applied[0].performance[0]['브랜드'], 'AUBE SEOUL');
  assert.equal(applied[1].performance[0]['브랜드'], '공장(용저우)');
  assert.equal(applied[0].performance[0]['조회수'], 12);
  assert.equal(applied[0].performance[0]['인사이트_귀속'], 'account_window_not_post_causal');
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
  assert.equal(runs[0].status, 'ok');
  const built = buildPostSnapshot({ post_id: 'p1' }, [
    { observed_at: '2026-11-26T00:00:00Z', age_hours: 24, metrics: { views: 4 } },
    { observed_at: '2026-11-28T00:00:00Z', age_hours: 72, metrics: { views: 12 } },
  ]);
  assert.equal(built.ms.t1.s, 'c');
  assert.equal(built.latest.m.v, 12);

  const source = fs.readFileSync(new URL('../supabase/functions/threads-collector/index.js', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../supabase/functions/threads-collector/job.js', import.meta.url), 'utf8');
  for (const banned of ['threads_publish', 'publish_container', 'create_container', 'reply_to_id']) {
    assert.equal(source.includes(banned), false, banned);
  }
  const sql = fs.readFileSync(new URL('../supabase/migrations/20261128160000_threads_collector.sql', import.meta.url), 'utf8');
  assert.match(sql, /threads_collector_runs/);
  assert.match(sql, /revoke all on table public\.threads_token_store from public, anon, authenticated/i);
  assert.equal(sql.includes('grant select on table public.threads_token_store to anon'), false);
});

test('the analysis page does not add a sync control or put performance rows in the boot cache', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /마지막 수집/);
  assert.match(html, /누적 글 수/);
  assert.match(html, /글당 중앙값 조회수/);
  assert.match(html, /좋아요\+답글/);
  assert.match(html, /api\/threads-performance/);
  assert.equal(html.includes('THREADS_DASHBOARD_ACCESS_KEY'), false);
  assert.equal(html.includes('노션에서 동기화'), false);
  assert.match(html, /SNAP_ARR=\['contents'/);
  assert.equal(html.includes("'perf'") || html.includes('"perf"'), false);
});
