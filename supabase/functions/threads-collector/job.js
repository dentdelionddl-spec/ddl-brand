// Threads collector job. Reads Graph API, writes hermes tables and the
// performance rows the analysis screen reads. No publishing, no replies.

import {
  ACCOUNT_ATTRIBUTION,
  COLLECTOR_BRANDS,
  INSIGHT_PAUSE_MS,
  POST_METRICS,
  accountWindowFor,
  activeBrands,
  buildPostSnapshot,
  decideTokenRefresh,
  explicitT2,
  fingerprint,
  numericMetrics,
  observationFromMetric,
  performancePatch,
  redactSecrets,
  seoulDate,
  sinceDate,
} from '../../../lib/threads-collector.js';

const BASE = 'https://graph.threads.net/v1.0';
const POST_FIELDS = 'id,text,timestamp,permalink,media_type,is_quote_post';
const INSIGHT_METRICS = POST_METRICS.join(',');

export async function runJob(job, ctx) {
  const now = ctx.now || new Date();
  const db = ctx.db || createRestDb(ctx);
  const api = ctx.api || createThreadsApi(ctx);
  const started = now.toISOString();
  if (job === 'token_refresh') return refreshTokens({ db, api, now, started });
  if (job === 'metrics' || job === 'archive') return collect({ job, db, api, now, started, withAccount: job === 'archive' });
  throw new Error('모르는 job: ' + job);
}

async function collect({ job, db, api, now, started, withAccount }) {
  const since = sinceDate(now);
  const lines = [];
  let posts = 0;
  let brands = 0;
  let warnings = 0;
  const secrets = [];
  for (const brand of activeBrands(now)) {
    const token = await tokenFor(db, brand);
    if (!token) {
      lines.push(`${brand.name}: 토큰 없음`);
      continue;
    }
    secrets.push(token);
    try {
      const list = await api.fetchPosts(token, since);
      await api.attachInsights(list, token);
      const account = withAccount ? await api.fetchAccountInsights(token, 'followers_count').catch((error) => {
        warnings += 1;
        return { error: redactSecrets(error?.message || error, [token]) };
      }) : null;
      const baselines = withAccount ? await db.readAccountSnapshots(brand.name) : [];
      const history = await db.readMetrics(brand.name, list.map((post) => post.id));
      const collectedAt = now.toISOString();
      const stamp = collectedAt.replace(/[:.]/g, '');
      const sourceFile = `edge/threads-collector/${job}/${brand.name}/${stamp}.json`;
      const metrics = [];
      const performance = [];
      const completedT2 = new Set(
        history.filter((row) => row?.extra?.t2_insights?.status === 'complete').map((row) => row.post_id),
      );
      for (const post of list) {
        const window = withAccount && account && !account.error && !completedT2.has(post.id)
          ? accountWindowFor(post, list, account, baselineBefore(baselines, post), collectedAt)
          : null;
        const t2 = window ? explicitT2(post, window, collectedAt) : null;
        const extra = t2 ? { t2_insights: t2 } : {};
        metrics.push({
          brand: brand.name,
          post_id: post.id,
          collected_at: collectedAt,
          source_file: sourceFile,
          ...metricColumns(post),
          extra,
        });
        const observations = history
          .filter((row) => row.post_id === post.id)
          .map((row) => observationFromMetric(post, row))
          .filter(Boolean);
        const fresh = observationFromMetric(post, { ...post, collected_at: collectedAt });
        if (fresh) observations.push(fresh);
        const snapshot = buildPostSnapshot(
          { ...post, post_id: post.id },
          observations,
          t2,
        );
        performance.push(performancePatch(brand, post, snapshot, window));
      }
      await db.apply({
        brand: brand.name,
        posts: list.map((post) => postRow(brand.name, post, collectedAt)),
        metrics,
        performance,
        account: account && !account.error ? {
          brand: brand.name,
          collected_at: collectedAt,
          followers_count: account.metrics?.followers_count ?? null,
          profile_views: account.metrics?.views ?? null,
        } : null,
      });
      brands += 1;
      posts += list.length;
      lines.push(`${brand.name}: ${list.length}건`);
    } catch (error) {
      warnings += 1;
      lines.push(`${brand.name}: ${redactSecrets(error?.message || error, secrets)}`);
    }
  }
  const status = warnings ? 'error' : 'ok';
  const run = {
    job,
    status,
    started_at: started,
    finished_at: new Date().toISOString(),
    posts,
    brands,
    error: warnings ? lines.filter((line) => line.includes(':') && !line.endsWith('건')).join(' | ').slice(0, 500) : '',
    detail: { since, lines, attribution: ACCOUNT_ATTRIBUTION },
  };
  await db.insertRun(run);
  return { ok: status === 'ok', ...run, detail: undefined, lines };
}

async function refreshTokens({ db, api, now, started }) {
  const lines = [];
  let warnings = 0;
  const secrets = [];
  for (const brand of activeBrands(now)) {
    const token = await tokenFor(db, brand);
    if (!token) {
      lines.push(`${brand.display}: 토큰 없음`);
      continue;
    }
    secrets.push(token);
    const state = await db.readTokenState(brand.name);
    let meError = null;
    try { await api.me(token); } catch (error) { meError = error; }
    if (meError) {
      warnings += 1;
      lines.push(`${brand.display}: ${redactSecrets(meError.message || meError, secrets)}`);
      continue;
    }
    let response = null;
    let error = null;
    const probe = { token_fingerprint: state?.token_fingerprint, expires_at: state?.expires_at, refresh_failed_at: state?.refresh_failed_at };
    if (decideTokenRefresh(brand, token, now, probe, null, null).status === '정상') {
      lines.push(`${brand.display}: 정상`);
      continue;
    }
    try { response = await api.refresh(token); } catch (err) { error = err?.message || String(err); }
    const decision = decideTokenRefresh(brand, token, now, probe, response, error);
    if (decision.status === 'error') {
      warnings += 1;
      lines.push(`${brand.display}: ${decision.error}`);
      continue;
    }
    await db.writeToken(brand, decision.token, decision.record);
    secrets.push(decision.token);
    lines.push(`${brand.display}: ${decision.status}`);
  }
  const run = {
    job: 'token_refresh',
    status: warnings ? 'error' : 'ok',
    started_at: started,
    finished_at: new Date().toISOString(),
    posts: 0,
    brands: activeBrands(now).length,
    error: warnings ? lines.join(' | ').slice(0, 500) : '',
    detail: { lines },
  };
  await db.insertRun(run);
  return { ok: run.status === 'ok', job: run.job, status: run.status, lines };
}

async function tokenFor(db, brand) {
  const stored = await db.readToken(brand.name);
  if (stored) return stored;
  return String(brand.envToken || '') || null;
}

function postRow(brand, post, collectedAt) {
  return {
    brand,
    post_id: post.id,
    text: post.text || '',
    posted_at: post.timestamp || null,
    permalink: post.permalink || null,
    media_type: post.media_type || null,
    is_quote_post: !!post.is_quote_post,
    first_collected_at: collectedAt,
    last_collected_at: collectedAt,
  };
}

function metricColumns(post) {
  const metrics = numericMetrics(post);
  return {
    views: metrics.views ?? null,
    likes: metrics.likes ?? null,
    replies: metrics.replies ?? null,
    reposts: metrics.reposts ?? null,
    quotes: metrics.quotes ?? null,
    shares: metrics.shares ?? null,
  };
}

function baselineBefore(snapshots, post) {
  const published = new Date(post.timestamp || 0).getTime();
  const earlier = (snapshots || []).filter((row) => new Date(row.collected_at).getTime() <= published && typeof row.followers_count === 'number');
  return earlier.sort((a, b) => String(a.collected_at).localeCompare(String(b.collected_at))).at(-1) || null;
}

export function createThreadsApi(ctx) {
  const fetchImpl = ctx.fetchImpl || fetch;
  const pauseMs = ctx.pauseMs ?? INSIGHT_PAUSE_MS;
  const sleep = ctx.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  async function getJson(url, operation) {
    let response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      throw new Error(`Threads API ${operation} 실패(network): ${redactSecrets(error?.message || error, [url])}`);
    }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok || payload?.error) {
      const message = payload?.error?.message || response.statusText || '알 수 없는 API 오류';
      throw new Error(`Threads API ${operation} 실패(${response.status || 'api'}): ${redactSecrets(message, [url])}`);
    }
    return payload;
  }
  return {
    async me(token) {
      return getJson(`${BASE}/me?fields=id,username&access_token=${encodeURIComponent(token)}`, 'me');
    },
    async refresh(token) {
      const query = new URLSearchParams({ grant_type: 'th_refresh_token', access_token: token });
      return getJson(`${BASE}/refresh_access_token?${query}`, 'refresh');
    },
    async fetchPosts(token, since) {
      const posts = [];
      let url = `${BASE}/me/threads?fields=${POST_FIELDS}&limit=100&access_token=${encodeURIComponent(token)}`;
      if (since) url += `&since=${encodeURIComponent(since)}`;
      while (url) {
        const page = await getJson(url, 'posts');
        posts.push(...(page.data || []));
        url = page.paging?.next || '';
      }
      return posts;
    },
    async attachInsights(posts, token) {
      for (const post of posts) {
        try {
          const payload = await getJson(
            `${BASE}/${encodeURIComponent(post.id)}/insights?metric=${INSIGHT_METRICS}&access_token=${encodeURIComponent(token)}`,
            'insights',
          );
          for (const item of payload.data || []) {
            const total = item?.total_value?.value;
            const value = typeof total === 'number' ? total : item?.values?.[0]?.value;
            if (typeof value === 'number') post[item.name] = value;
          }
        } catch (error) {
          post.insights_error = redactSecrets(error.message || error, [token]).slice(0, 120);
        }
        if (pauseMs) await sleep(pauseMs);
      }
      return posts;
    },
    async fetchAccountInsights(token, metrics) {
      const query = new URLSearchParams({ metric: metrics || 'views,followers_count', access_token: token });
      const payload = await getJson(`${BASE}/me/threads_insights?${query}`, 'account_insights');
      const out = { metrics: {}, series: {} };
      for (const item of payload.data || []) {
        const name = String(item.name || '');
        const total = item?.total_value?.value;
        if (typeof total === 'number') out.metrics[name] = total;
        else if (name === 'followers_count' && item.values?.length) {
          const last = item.values[item.values.length - 1];
          if (typeof last?.value === 'number') out.metrics[name] = last.value;
        } else if (item.values?.length) {
          out.metrics[name] = item.values.reduce((sum, row) => sum + (typeof row.value === 'number' ? row.value : 0), 0);
        }
      }
      return out;
    },
  };
}

export function createRestDb(ctx) {
  const env = ctx.env || {};
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  const fetchImpl = ctx.fetchImpl || fetch;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  const headers = { apikey: key, Accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  async function rest(path, { method = 'GET', query, body } = {}) {
    const u = new URL(url + '/rest/v1/' + path);
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        if (value != null && value !== '') u.searchParams.set(name, String(value));
      }
    }
    const response = await fetchImpl(u, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
      const message = data?.message || data?.error || response.statusText || 'supabase error';
      throw new Error(redactSecrets(message, [key]));
    }
    return data;
  }
  return {
    async readToken(brand) {
      const envToken = envFor(brand, env);
      const rows = await rest('threads_token_store', { query: { select: 'access_token', brand: `eq.${brand}`, limit: 1 } }).catch(() => []);
      const stored = Array.isArray(rows) ? rows[0]?.access_token : '';
      return stored || envToken || null;
    },
    async readTokenState(brand) {
      const rows = await rest('threads_token_store', {
        query: { select: 'token_fingerprint,expires_at,refresh_failed_at,refresh_error', brand: `eq.${brand}`, limit: 1 },
      }).catch(() => []);
      return Array.isArray(rows) ? rows[0] || null : null;
    },
    async writeToken(brand, token, record) {
      await rest('rpc/threads_collector_save_token', {
        method: 'POST',
        body: {
          p_brand: brand.name,
          p_token_env: brand.threadsTokenEnv,
          p_access_token: token,
          p_fingerprint: record.token_fingerprint || fingerprint(token),
          p_expires_at: record.expires_at || null,
          p_refreshed_at: record.refreshed_at || null,
          p_first_seen_at: record.first_seen_at || null,
          p_refresh_failed_at: record.refresh_failed_at || null,
          p_refresh_error: record.refresh_error || null,
        },
      });
    },
    async readMetrics(brand, postIds) {
      if (!postIds?.length) return [];
      const rows = await rest('threads_post_metrics_read', {
        query: {
          select: 'post_id,collected_at,views,likes,replies,reposts,quotes,shares,extra',
          brand: `eq.${brand}`,
          post_id: `in.(${postIds.join(',')})`,
          order: 'collected_at.asc',
          limit: 10000,
        },
      }).catch(() => []);
      return Array.isArray(rows) ? rows : [];
    },
    async readAccountSnapshots(brand) {
      const rows = await rest('threads_account_snapshots', {
        query: { select: 'collected_at,followers_count', brand: `eq.${brand}`, order: 'collected_at.asc', limit: 5000 },
      }).catch(() => []);
      return Array.isArray(rows) ? rows : [];
    },
    async apply(payload) {
      await rest('rpc/threads_collector_apply', { method: 'POST', body: { payload } });
    },
    async insertRun(run) {
      await rest('rpc/threads_collector_log', {
        method: 'POST',
        body: {
          p_job: run.job,
          p_status: run.status,
          p_started_at: run.started_at,
          p_finished_at: run.finished_at,
          p_posts: run.posts || 0,
          p_brands: run.brands || 0,
          p_error: run.error || '',
          p_detail: run.detail || {},
        },
      });
    },
  };
}

function envFor(brandName, env) {
  const brand = COLLECTOR_BRANDS.find((item) => item.name === brandName);
  if (!brand) return '';
  return String(env[brand.threadsTokenEnv] || '');
}

export function seoulStamp(now) {
  return seoulDate(now);
}
