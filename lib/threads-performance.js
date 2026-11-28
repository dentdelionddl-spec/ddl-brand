// Threads performance rows, read from public.threads_performance
// (notion.threads_performance). Parsing matches ddl-dashboard so the
// analysis tab shows the same posts, medians, and curves.
// The service role key stays in lib/supabase.js. This module never
// talks to Notion.

import { rest } from './supabase.js';

export const HORIZONS = [
  ['t1', 'T+1'],
  ['t2', 'T+2'],
  ['t3', 'T+3'],
  ['t7', 'T+7'],
  ['t14', 'T+14'],
  ['t30', 'T+30'],
];

export const TREND_METRICS = [
  ['views', '조회'],
  ['likes', '좋아요'],
  ['replies', '답글'],
  ['reposts', '재게시'],
];

// Notion select value -> label shown on the original dashboard.
export const BRAND_LABELS = {
  ARIKIV: '아리키브',
  'AUBE SEOUL': '오브서울',
  '공장(용저우)': '미싱맨',
  MISSINGMAN: '미싱맨',
  OOTN: '오오티엔',
  VIVICATE: '비비케이트',
};

// Screen brand id (ddl-brand) -> every name the source row might carry.
// hermes.threads_posts.brand is the slug. notion.threads_performance."브랜드"
// is the select. The dashboard label is the Korean pill.
export const SCREEN_BRANDS = {
  aube: {
    label: '오브서울',
    keys: ['aube', 'AUBE SEOUL', '오브서울', 'aube-seoul', 'AUBE'],
  },
  factory: {
    label: '미싱맨',
    keys: ['factory', '공장(용저우)', '미싱맨', 'missingman', 'MISSINGMAN', '공장', '용저우 공장'],
  },
  vivicate: {
    label: '비비케이트',
    keys: ['vivicate', 'VIVICATE', '비비케이트'],
  },
  ootn: {
    label: '오오티엔',
    keys: ['ootn', 'OOTN', '오오티엔'],
  },
  ruhel: {
    label: '루엘',
    keys: ['ruhel', 'RUHEL', '루엘'],
  },
  usuel: {
    label: '유주엘',
    keys: ['usuel', 'USUEL', '유주엘'],
  },
  arikiv: {
    label: '아리키브',
    keys: ['arikiv', 'ARIKIV', '아리키브'],
  },
  ddl: {
    label: 'DDL',
    keys: ['ddl', 'DDL', '팀 디디엘'],
  },
};

const SNAPSHOT_VERSIONS = new Set([1, 2]);
const SERIES_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'];

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[\s\-_.()（）]/g, '');

export function screenBrandKeys(brand) {
  const id = String(brand?.id || brand || '').toLowerCase();
  const known = SCREEN_BRANDS[id];
  const extra = [brand?.id, brand?.name, brand?.ko, ...(brand?.aliases || [])];
  return [...new Set([...(known?.keys || []), ...extra].map((v) => String(v || '').trim()).filter(Boolean))];
}

export function screenBrandLabel(brand) {
  const id = String(brand?.id || brand || '').toLowerCase();
  return SCREEN_BRANDS[id]?.label || brand?.ko || brand?.name || '';
}

export function rowMatchesBrand(row, brand) {
  if (!brand) return true;
  const keys = new Set(screenBrandKeys(brand).map(norm));
  if (!keys.size) return true;
  const values = [row?.brand, row?.brandLabel, row?.hermesBrand].map(norm).filter(Boolean);
  return values.some((v) => keys.has(v));
}

export function trendPosition(ageHours, minAge, maxAge) {
  if (![ageHours, minAge, maxAge].every((value) => typeof value === 'number' && Number.isFinite(value))) return 0;
  if (maxAge <= minAge) return 0;
  const offset = Math.min(Math.max(ageHours - minAge, 0), maxAge - minAge);
  return Math.log1p(offset) / Math.log1p(maxAge - minAge);
}

export function matchesPostQuery(row, query) {
  const needle = String(query || '').trim().toLocaleLowerCase('ko-KR');
  if (!needle) return true;
  return [row?.body, row?.title, row?.brandLabel, row?.brand]
    .some((value) => String(value || '').toLocaleLowerCase('ko-KR').includes(needle));
}

const text = (prop, type = 'rich_text') =>
  (prop?.[type] || []).map((item) => item.plain_text || '').join('').trim();
const number = (prop) => {
  const value = prop?.number;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const select = (prop) => prop?.select?.name || '';
const date = (prop) => prop?.date?.start || '';

export function parsePerformanceSnapshot(value) {
  if (!value) return null;
  try {
    const source = JSON.parse(value);
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    if (
      !SNAPSHOT_VERSIONS.has(source.v) || source.scope !== 'post_lifetime' ||
      source.account !== 'excluded' || !String(source.pid || '').trim()
    ) return null;
    const metricNames = { v: 'views', l: 'likes', r: 'replies', rp: 'reposts', q: 'quotes', s: 'shares' };
    const expandMetrics = (metrics = {}) => Object.fromEntries(
      Object.entries(metrics)
        .filter(([key, item]) => metricNames[key] && typeof item === 'number' && Number.isFinite(item))
        .map(([key, item]) => [metricNames[key], item]),
    );
    const statusNames = { c: 'complete', p: 'pending', m: 'missing' };
    const milestones = {};
    for (const [key, item] of Object.entries(source.ms || {})) {
      const status = statusNames[item?.s];
      if (!status) return null;
      milestones[key] = {
        status,
        observed_at: item.at || null,
        observed_age_hours: typeof item.age_h === 'number' ? item.age_h : null,
        metrics: expandMetrics(item.m),
      };
    }
    const series = (Array.isArray(source.o) ? source.o : []).flatMap((point) => {
      if (!Array.isArray(point) || typeof point[0] !== 'number' || !Number.isFinite(point[0])) return [];
      const metrics = Object.fromEntries(
        SERIES_METRICS.flatMap((name, index) => {
          const item = point[index + 1];
          return typeof item === 'number' && Number.isFinite(item) ? [[name, item]] : [];
        }),
      );
      return Object.keys(metrics).length ? [{ ageHours: point[0], metrics }] : [];
    });
    return {
      schema_version: source.v,
      post_id: String(source.pid),
      as_of: source.as_of || source.latest?.at || '',
      observation_count: typeof source.obs === 'number' ? source.obs : 0,
      latest: {
        observed_at: source.latest?.at || null,
        age_hours: typeof source.latest?.age_h === 'number' ? source.latest.age_h : null,
        metrics: expandMetrics(source.latest?.m),
      },
      milestones,
      latest_delta: expandMetrics(source.d?.m),
      latest_per_day: expandMetrics(source.d?.pd),
      series,
    };
  } catch {
    return null;
  }
}

function normalizedMetrics(metrics = {}, fallback = {}) {
  const result = {};
  for (const key of SERIES_METRICS) {
    const value = metrics[key] ?? fallback[key];
    result[key] = typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return result;
}

function fallbackT2(properties, fallbackMetrics) {
  const observedAt = date(properties['인사이트 관측시각']);
  if (!observedAt) return null;
  return {
    status: 'complete',
    observed_at: observedAt,
    observed_age_hours: number(properties['관측 경과시간']),
    metrics: fallbackMetrics,
  };
}

export function parsePerformanceRow(page) {
  const properties = page?.properties || {};
  const rawBrand = select(properties['브랜드']) || '미지정';
  const postId = text(properties['로컬ID']);
  const fallbackMetrics = normalizedMetrics({}, {
    views: number(properties['조회수']),
    likes: number(properties['좋아요']),
    replies: number(properties['댓글']),
  });
  const parsedSnapshot = parsePerformanceSnapshot(text(properties['누적 성과 스냅샷']));
  const snapshot = parsedSnapshot && (!postId || parsedSnapshot.post_id === postId)
    ? parsedSnapshot
    : null;
  const latest = snapshot?.latest || {};
  const milestones = { ...(snapshot?.milestones || {}) };
  if (!milestones.t2) {
    const t2 = fallbackT2(properties, fallbackMetrics);
    if (t2) milestones.t2 = t2;
  }
  return {
    id: page.id,
    postId,
    title: text(properties['제목'], 'title'),
    body: text(properties['본문']),
    permalink: properties['URL']?.url || '',
    publishedAt: date(properties['발행일']),
    brand: rawBrand,
    brandLabel: BRAND_LABELS[rawBrand] || rawBrand,
    hasImage: Boolean(properties['이미지 유무']?.checkbox),
    latestObservedAt: latest.observed_at || snapshot?.as_of || date(properties['인사이트 관측시각']),
    metrics: normalizedMetrics(latest.metrics || {}, fallbackMetrics),
    milestones,
    latestDelta: snapshot?.latest_delta || {},
    series: snapshot?.series || [],
    accountContext: {
      observedAt: date(properties['인사이트 관측시각']),
      ageHours: number(properties['관측 경과시간']),
      profileViews: number(properties['프로필 유입']),
      followersAtPublish: number(properties['발행시 팔로워']),
      followersAtObservation: number(properties['관측시 팔로워']),
      followersDelta: number(properties['팔로우 전환']),
      overlappingPosts: number(properties['동시 게시물 수']),
      attribution: text(properties['인사이트 귀속']),
    },
    snapshotVersion: snapshot?.schema_version || null,
    snapshotStatus: parsedSnapshot && !snapshot ? 'post_id_mismatch' : snapshot ? 'verified' : 'fallback',
  };
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const titleProp = (value) => ({ title: [{ plain_text: value == null ? '' : String(value) }] });
const richProp = (value) => ({ rich_text: [{ plain_text: value == null ? '' : String(value) }] });
const numProp = (value) => {
  const n = asNumber(value);
  return n == null ? undefined : { number: n };
};

export function pageFromPerformanceRecord(row) {
  const properties = {};
  const put = (name, prop) => { if (prop !== undefined) properties[name] = prop; };
  put('제목', titleProp(row['제목']));
  put('본문', richProp(row['본문']));
  put('로컬ID', richProp(row['로컬id']));
  put('누적 성과 스냅샷', richProp(row['누적_성과_스냅샷']));
  put('인사이트 귀속', richProp(row['인사이트_귀속']));
  if (row['브랜드']) properties['브랜드'] = { select: { name: String(row['브랜드']) } };
  if (row.userdefined_url) properties.URL = { url: String(row.userdefined_url) };
  if (row['발행일_start']) properties['발행일'] = { date: { start: String(row['발행일_start']) } };
  if (row['인사이트_관측시각_start']) properties['인사이트 관측시각'] = { date: { start: String(row['인사이트_관측시각_start']) } };
  put('조회수', numProp(row['조회수']));
  put('좋아요', numProp(row['좋아요']));
  put('댓글', numProp(row['댓글']));
  put('프로필 유입', numProp(row['프로필_유입']));
  put('팔로우 전환', numProp(row['팔로우_전환']));
  put('발행시 팔로워', numProp(row['발행시_팔로워']));
  put('관측시 팔로워', numProp(row['관측시_팔로워']));
  put('동시 게시물 수', numProp(row['동시_게시물_수']));
  put('관측 경과시간', numProp(row['관측_경과시간']));
  if (row['이미지_유무'] != null) properties['이미지 유무'] = { checkbox: !!row['이미지_유무'] };
  return { id: row.notion_page_id || '', properties };
}

function median(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function comparableMetrics(row, horizon = 't7') {
  const milestone = row?.milestones?.[horizon];
  return milestone?.status === 'complete' ? milestone.metrics || {} : null;
}

function bodyProfile(row) {
  const body = String(row?.body || row?.title || '').trim();
  const lines = body.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return { body, firstLine: lines[0] || '', lines: lines.length, chars: body.replace(/\s/g, '').length };
}

function groupStats(items) {
  const views = items.map((item) => item.metrics.views);
  const replyRates = items.flatMap((item) => {
    const value = item.metrics.views;
    const replies = item.metrics.replies;
    return typeof value === 'number' && value > 0 && typeof replies === 'number' ? [replies / value] : [];
  });
  return { count: items.length, medianViews: median(views), medianReplyRate: median(replyRates) };
}

function compareGroups(positive, negative, metric) {
  const first = positive[metric];
  const second = negative[metric];
  if (typeof first !== 'number' || typeof second !== 'number') return null;
  if (first === second) return { winner: 'tie', multiple: 1 };
  const high = Math.max(first, second);
  const low = Math.min(first, second);
  if (low <= 0) return null;
  return { winner: first > second ? 'positive' : 'negative', multiple: high / low };
}

export function buildContentInsights(rows, { horizon = 't7', minimumGroup = 3 } = {}) {
  const comparable = rows.flatMap((row) => {
    const metrics = comparableMetrics(row, horizon);
    if (!metrics || typeof metrics.views !== 'number') return [];
    return [{ row, metrics, profile: bodyProfile(row) }];
  });
  const lengthMedian = median(comparable.map((item) => item.profile.chars));
  const definitions = [
    { key: 'question_open', positiveLabel: '첫 줄 질문형', negativeLabel: '첫 줄 서술형', test: (item) => /[?？]/.test(item.profile.firstLine) },
    { key: 'line_breaks', positiveLabel: '4줄 이상', negativeLabel: '3줄 이하', test: (item) => item.profile.lines >= 4 },
    { key: 'image', positiveLabel: '이미지 포함', negativeLabel: '텍스트만', test: (item) => Boolean(item.row.hasImage) },
    ...(typeof lengthMedian === 'number' ? [{
      key: 'copy_length',
      positiveLabel: `짧은 글 (${Math.round(lengthMedian)}자 이하)`,
      negativeLabel: `긴 글 (${Math.round(lengthMedian)}자 초과)`,
      test: (item) => item.profile.chars <= lengthMedian,
    }] : []),
  ];
  return definitions.flatMap((definition) => {
    const positiveItems = comparable.filter(definition.test);
    const negativeItems = comparable.filter((item) => !definition.test(item));
    if (positiveItems.length < minimumGroup || negativeItems.length < minimumGroup) return [];
    const positive = groupStats(positiveItems);
    const negative = groupStats(negativeItems);
    const reach = compareGroups(positive, negative, 'medianViews');
    const conversation = compareGroups(positive, negative, 'medianReplyRate');
    const strength = Math.max(reach?.multiple || 1, conversation?.multiple || 1);
    return [{ ...definition, horizon, positive, negative, reach, conversation, strength }];
  }).sort((a, b) => b.strength - a.strength);
}

export function summarizePerformance(rows) {
  const metric = (name) => rows.map((row) => row.metrics[name]);
  const sum = (name) => metric(name).reduce((total, value) => total + (typeof value === 'number' ? value : 0), 0);
  const coverage = Object.fromEntries(HORIZONS.map(([key]) => {
    const statuses = rows.map((row) => row.milestones[key]?.status || 'pending');
    return [key, {
      complete: statuses.filter((status) => status === 'complete').length,
      missing: statuses.filter((status) => status === 'missing').length,
      pending: statuses.filter((status) => status === 'pending').length,
    }];
  }));
  const published = rows.map((row) => row.publishedAt).filter(Boolean).sort();
  return {
    posts: rows.length,
    views: sum('views'),
    likes: sum('likes'),
    replies: sum('replies'),
    medianViews: median(metric('views')),
    coverage,
    latestObservedAt: rows.map((row) => row.latestObservedAt).filter(Boolean).sort().at(-1) || '',
    latestPublishedAt: published.at(-1) || '',
  };
}

export function toClientRow(row) {
  const milestones = {};
  for (const [key] of HORIZONS) {
    const item = row.milestones?.[key];
    if (!item) continue;
    milestones[key] = {
      status: item.status,
      metrics: { views: item.metrics?.views ?? null },
    };
  }
  return {
    id: row.id,
    postId: row.postId,
    title: row.title,
    body: row.body,
    permalink: row.permalink,
    publishedAt: row.publishedAt,
    brand: row.brand,
    brandLabel: row.brandLabel,
    hasImage: row.hasImage,
    latestObservedAt: row.latestObservedAt,
    metrics: row.metrics,
    milestones,
    series: row.series,
    accountContext: {
      profileViews: row.accountContext?.profileViews ?? null,
      followersDelta: row.accountContext?.followersDelta ?? null,
    },
  };
}

const PERFORMANCE_SELECT = [
  'notion_page_id', '제목', '본문', '브랜드', '조회수', '좋아요', '댓글',
  '프로필_유입', '팔로우_전환', '발행일_start', '발행시_팔로워', '관측시_팔로워',
  '동시_게시물_수', '이미지_유무', '인사이트_관측시각_start', '관측_경과시간',
  '인사이트_귀속', '누적_성과_스냅샷', 'userdefined_url', '로컬id',
].join(',');

export async function loadPerformanceRows() {
  const out = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const page = await rest('threads_performance', {
      query: {
        select: PERFORMANCE_SELECT,
        deleted_at: 'is.null',
        order: '발행일_start.desc.nullslast',
        limit,
        offset,
      },
    });
    const list = Array.isArray(page) ? page : [];
    out.push(...list);
    if (list.length < limit) break;
  }
  return out
    .map((record) => parsePerformanceRow(pageFromPerformanceRecord(record)))
    .filter((row) =>
      row.postId || row.permalink || row.body || row.title ||
      Object.values(row.metrics).some((value) => typeof value === 'number'));
}

export async function loadCollectorLog() {
  try {
    const rows = await rest('threads_collector_runs', {
      query: {
        select: 'job,status,started_at,finished_at,posts,brands,error',
        order: 'finished_at.desc',
        limit: 8,
      },
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return null;
  }
}

export function collectionStamp(rows, log) {
  const observed = rows.map((row) => row.latestObservedAt).filter(Boolean).sort().at(-1) || '';
  const list = Array.isArray(log) ? log : [];
  const success = list.find((row) => row.status === 'ok' && row.finished_at);
  const last = list[0] || null;
  if (success?.finished_at) {
    return {
      collectedAt: success.finished_at,
      source: 'log',
      observedAt: observed,
      lastRun: last,
      lastSuccess: success,
    };
  }
  return {
    collectedAt: observed,
    source: observed ? 'observations' : 'none',
    observedAt: observed,
    lastRun: last,
    lastSuccess: null,
  };
}
