// Pure Threads collector rules ported from the Hermes jobs.
// No tokens, no network. The edge function applies these results.

import { createHash } from 'node:crypto';

export const POST_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'];
export const HORIZONS = [
  ['t1', 24, 24],
  ['t2', 48, 24],
  ['t3', 72, 48],
  ['t7', 168, 72],
  ['t14', 336, 96],
  ['t30', 720, 120],
];
export const OBSERVATION_WINDOW_DAYS = 32;
export const T2_MIN_HOURS = 48;
export const T2_MAX_HOURS = 96;
export const TOKEN_LIFETIME_SEC = 60 * 24 * 60 * 60;
export const REFRESH_BEFORE_MS = 14 * 24 * 60 * 60 * 1000;
export const INSIGHT_PAUSE_MS = 200;
export const ACCOUNT_ATTRIBUTION = 'account_window_not_post_causal';

// threads_token_env is the Supabase secret name, same field brands.py reads.
// Slugs match hermes.threads_posts.brand. notionBrand is the select on
// notion.threads_performance. arikiv stopped before the live performance
// table and stays disabled until someone turns it back on.
export const COLLECTOR_BRANDS = [
  {
    name: 'aube-seoul',
    display: 'AUBE SEOUL',
    uiLabel: '오브서울',
    notionBrand: 'AUBE SEOUL',
    threadsTokenEnv: 'THREADS_TOKEN_AUBE_SEOUL',
    enabled: true,
  },
  {
    name: 'missingman',
    display: '미싱맨',
    uiLabel: '미싱맨',
    notionBrand: '공장(용저우)',
    threadsTokenEnv: 'THREADS_TOKEN_MISSINGMAN',
    enabled: true,
  },
  {
    name: 'arikiv',
    display: 'ARIKIV',
    uiLabel: '아리키브',
    notionBrand: 'ARIKIV',
    threadsTokenEnv: 'THREADS_TOKEN_ARIKIV',
    enabled: false,
  },
];

export function activeBrands(now = new Date()) {
  return COLLECTOR_BRANDS.filter((brand) => isActive(brand, now));
}

export function isActive(brand, now = new Date()) {
  if (!brand?.enabled) return false;
  const life = brand.lifecycle || {};
  const today = seoulDate(now);
  if (life.active_from && today < String(life.active_from).slice(0, 10)) return false;
  if (life.active_until && today > String(life.active_until).slice(0, 10)) return false;
  return true;
}

export function seoulDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function parseTime(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function numericMetrics(post) {
  const out = {};
  for (const field of POST_METRICS) {
    const value = post?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) out[field] = Number(value);
  }
  return out;
}

export function redactSecrets(text, secrets) {
  let out = String(text || '');
  for (const secret of secrets || []) {
    const token = String(secret || '');
    if (token.length < 6) continue;
    out = out.split(token).join('[REDACTED]');
  }
  return out.slice(0, 500);
}

export function fingerprint(token) {
  return createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

export function refreshDue(record, now) {
  if (!record?.expires_at) return true;
  const expires = parseTime(record.expires_at);
  if (!expires) return true;
  return expires.getTime() - now.getTime() <= REFRESH_BEFORE_MS;
}

// Mirrors token-refresh.py refresh_brand, without writing the secret.
// Returns { status, record, token, changed }.
export function decideTokenRefresh(brand, token, now, state, response, error) {
  const current = fingerprint(token);
  let record = state && state.token_fingerprint === current
    ? { ...state }
    : { token_fingerprint: current, first_seen_at: now.toISOString() };
  if (!refreshDue(record, now)) {
    return { status: '정상', record, token, changed: false };
  }
  if (error) {
    const safe = redactSecrets(error, [token]);
    if (!record.refresh_failed_at) {
      record = { ...record, refresh_failed_at: now.toISOString(), refresh_error: safe };
      return { status: '유효·갱신 보류(다음 잡 재시도)', record, token, changed: false };
    }
    return { status: 'error', error: `Threads 토큰 갱신 실패: ${safe}`, record, token, changed: false };
  }
  const body = response || {};
  const next = body.access_token || token;
  const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : TOKEN_LIFETIME_SEC;
  record = {
    token_fingerprint: fingerprint(next),
    refreshed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    expires_in_sec: expiresIn,
  };
  return { status: '갱신 완료', record, token: next, changed: true };
}

export function sinceDate(now, windowDays = OBSERVATION_WINDOW_DAYS) {
  const day = seoulDate(now);
  const anchor = new Date(`${day}T00:00:00+09:00`);
  anchor.setUTCDate(anchor.getUTCDate() - 1 - (windowDays - 1));
  return seoulDate(anchor);
}

function horizonSnapshot(observations, targetHours, graceHours) {
  const eligible = observations.filter((item) => targetHours <= item.age_hours && item.age_hours < targetHours + graceHours);
  if (eligible.length) {
    const selected = eligible.reduce((best, item) => (item.age_hours < best.age_hours ? item : best));
    return {
      status: 'complete',
      target_age_hours: targetHours,
      observed_at: selected.observed_at,
      observed_age_hours: selected.age_hours,
      metrics: selected.metrics,
    };
  }
  const latestAge = observations.length ? observations[observations.length - 1].age_hours : null;
  const status = latestAge == null || latestAge < targetHours + graceHours ? 'pending' : 'missing';
  return { status, target_age_hours: targetHours, observed_at: null, observed_age_hours: null, metrics: {} };
}

const STATUS_CODE = { complete: 'c', pending: 'p', missing: 'm' };
const METRIC_CODE = { views: 'v', likes: 'l', replies: 'r', reposts: 'rp', quotes: 'q', shares: 's' };

function compactMetrics(metrics) {
  const out = {};
  for (const [name, code] of Object.entries(METRIC_CODE)) {
    const value = metrics?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) out[code] = value;
  }
  return out;
}

export function buildPostSnapshot(post, observations, explicitT2) {
  const deduped = new Map();
  for (const item of observations) {
    if (!item?.observed_at) continue;
    deduped.set(item.observed_at, item);
  }
  const series = [...deduped.values()].sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
  const milestones = {};
  for (const [key, target, grace] of HORIZONS) milestones[key] = horizonSnapshot(series, target, grace);
  if (explicitT2 && explicitT2.status === 'complete') {
    const current = milestones.t2;
    const nextAge = Number(explicitT2.observed_age_hours);
    const curAge = Number(current?.observed_age_hours);
    if (!current || current.status !== 'complete' || (Number.isFinite(nextAge) && (!Number.isFinite(curAge) || nextAge < curAge))) {
      milestones.t2 = explicitT2;
    }
  }
  const latest = series.at(-1) || null;
  const previous = series.length >= 2 ? series.at(-2) : null;
  const delta = {};
  const perDay = {};
  if (latest && previous) {
    const elapsedDays = (latest.age_hours - previous.age_hours) / 24;
    for (const field of POST_METRICS) {
      const cur = latest.metrics?.[field];
      const prev = previous.metrics?.[field];
      if (typeof cur === 'number' && typeof prev === 'number') {
        delta[field] = cur - prev;
        if (elapsedDays > 0) perDay[field] = Math.round(((cur - prev) / elapsedDays) * 100) / 100;
      }
    }
  }
  const ms = {};
  for (const [key, item] of Object.entries(milestones)) {
    const code = STATUS_CODE[item.status];
    if (!code) continue;
    const entry = { s: code };
    if (item.observed_at) entry.at = item.observed_at;
    if (typeof item.observed_age_hours === 'number') entry.age_h = item.observed_age_hours;
    const metrics = compactMetrics(item.metrics);
    if (Object.keys(metrics).length) entry.m = metrics;
    ms[key] = entry;
  }
  const points = series.map((item) => {
    const row = [item.age_hours];
    for (const name of POST_METRICS) {
      const value = item.metrics?.[name];
      row.push(typeof value === 'number' ? value : null);
    }
    return row;
  });
  return {
    v: 2,
    scope: 'post_lifetime',
    account: 'excluded',
    pid: String(post.post_id || post.id || ''),
    as_of: latest?.observed_at || '',
    obs: series.length,
    latest: latest ? {
      at: latest.observed_at,
      age_h: latest.age_hours,
      m: compactMetrics(latest.metrics),
    } : undefined,
    ms,
    d: { m: compactMetrics(delta), pd: compactMetrics(perDay) },
    o: points,
    _latestMetrics: latest?.metrics || {},
    _milestones: milestones,
  };
}

export function performancePatch(brand, post, snapshot, accountWindow) {
  const text = String(post.text || '').trim();
  const metrics = snapshot._latestMetrics || {};
  const published = parseTime(post.timestamp || post.posted_at);
  const latest = snapshot.latest || {};
  const t2 = snapshot._milestones?.t2;
  const account = accountWindow || {};
  const patch = {
    제목: text.slice(0, 80),
    본문: text.slice(0, 2000),
    브랜드: brand.notionBrand,
    채널: '스레드',
    로컬id: String(post.id || post.post_id || ''),
    userdefined_url: post.permalink || null,
    발행일_start: published ? seoulDate(published) : null,
    발행일_is_datetime: false,
    조회수: numOrNull(metrics.views),
    좋아요: numOrNull(metrics.likes),
    댓글: numOrNull(metrics.replies),
    이미지_유무: String(post.media_type || 'TEXT').toUpperCase() !== 'TEXT',
    누적_성과_스냅샷: JSON.stringify(publicSnapshot(snapshot)),
    인사이트_관측시각_start: latest.at || null,
    인사이트_관측시각_is_datetime: Boolean(latest.at),
    관측_경과시간: typeof latest.age_h === 'number' ? latest.age_h : null,
    last_edited_time: new Date().toISOString(),
  };
  if (t2?.status === 'complete' && account && Object.keys(account).length) {
    if (typeof account.profile_views === 'number') patch['프로필_유입'] = account.profile_views;
    if (typeof account.followers_at_publish === 'number') patch['발행시_팔로워'] = account.followers_at_publish;
    if (typeof account.followers_at_observation === 'number') patch['관측시_팔로워'] = account.followers_at_observation;
    if (typeof account.followers_delta === 'number') patch['팔로우_전환'] = account.followers_delta;
    if (typeof account.overlapping_post_count === 'number') patch['동시_게시물_수'] = account.overlapping_post_count;
    if (account.attribution) patch['인사이트_귀속'] = account.attribution;
  }
  return patch;
}

function publicSnapshot(snapshot) {
  const { _latestMetrics, _milestones, ...rest } = snapshot;
  return rest;
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function observationFromMetric(post, metric) {
  const published = parseTime(post.timestamp || post.posted_at);
  const observed = parseTime(metric.collected_at);
  if (!published || !observed) return null;
  const age = Math.round(((observed.getTime() - published.getTime()) / 3600000) * 100) / 100;
  if (age < 0) return null;
  return {
    observed_at: observed.toISOString(),
    age_hours: age,
    metrics: numericMetrics(metric),
  };
}

export function t2Window(post, collectedAt) {
  const published = parseTime(post.timestamp || post.posted_at);
  const collected = parseTime(collectedAt);
  if (!published || !collected) return null;
  const ageHours = (collected.getTime() - published.getTime()) / 3600000;
  if (ageHours < T2_MIN_HOURS || ageHours > T2_MAX_HOURS) return null;
  return {
    ageHours: Math.round(ageHours * 100) / 100,
    since: seoulDate(published),
    until: seoulDate(collected),
  };
}

export function accountWindowFor(post, posts, account, baseline, collectedAt) {
  const window = t2Window(post, collectedAt);
  if (!window || !account) return null;
  const metrics = account.metrics || {};
  const followersNow = metrics.followers_count;
  const followersBefore = baseline?.followers_count;
  const profileViews = metrics.views;
  const since = window.since;
  const until = window.until;
  const overlapping = posts.filter((item) => {
    const stamp = parseTime(item.timestamp || item.posted_at);
    if (!stamp) return false;
    const day = seoulDate(stamp);
    return since <= day && day <= until;
  }).length;
  const out = {
    scope: 'account',
    since,
    until,
    resolution: 'day',
    attribution: ACCOUNT_ATTRIBUTION,
    overlapping_post_count: overlapping,
  };
  if (typeof profileViews === 'number') out.profile_views = profileViews;
  if (typeof followersNow === 'number') out.followers_at_observation = followersNow;
  if (typeof followersBefore === 'number') out.followers_at_publish = followersBefore;
  if (typeof followersNow === 'number' && typeof followersBefore === 'number') {
    out.followers_delta = followersNow - followersBefore;
    if (typeof profileViews === 'number' && profileViews > 0) {
      out.profile_to_follower_conversion_estimate = Math.round((out.followers_delta / profileViews) * 1e6) / 1e6;
    }
  }
  return out;
}

export function explicitT2(post, accountWindow, collectedAt) {
  const window = t2Window(post, collectedAt);
  if (!window) return null;
  return {
    status: 'complete',
    target_age_hours: 48,
    observed_at: parseTime(collectedAt)?.toISOString() || String(collectedAt),
    observed_age_hours: window.ageHours,
    metrics: numericMetrics(post),
    account_window: accountWindow || undefined,
  };
}
