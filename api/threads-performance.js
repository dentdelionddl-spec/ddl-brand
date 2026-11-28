// Read-only Threads performance for the analysis tab.
// Same team Google login / share / embed check as /api/notion. The service role
// key stays on the server. This does not write and does not call Notion.

import { gzipSync } from 'node:zlib';
import { authorize } from './notion.js';
import {
  collectionStamp,
  loadCollectorLog,
  loadPerformanceRows,
  rowMatchesBrand,
  screenBrandLabel,
  summarizePerformance,
  toClientRow,
} from '../lib/threads-performance.js';

function reply(req, res, status, obj) {
  const accept = String(req.headers?.['accept-encoding'] || '');
  if (typeof res.end === 'function' && typeof res.setHeader === 'function' && /\bgzip\b/.test(accept)) {
    const raw = Buffer.from(JSON.stringify(obj));
    if (raw.length > 2048) {
      const zipped = gzipSync(raw, { level: 5 });
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Origin, Accept-Encoding');
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(zipped);
      return res;
    }
  }
  return res.status(status).json(obj);
}

export default async function handler(req, res) {
  const allowed = (process.env.ALLOW_ORIGIN || 'https://ddl-brand.vercel.app').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Share-Key, X-Embed-Brand');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST만 받습니다' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  if (!body) return res.status(400).json({ message: '요청 본문이 JSON이 아닙니다' });

  try {
    const who = await authorize(req);
    if (who.error) return res.status(who.status).json({ message: who.error });
    const brand = who.scope ? who.brand : brandFromBody(body);
    const rows = (await loadPerformanceRows()).filter((row) => rowMatchesBrand(row, brand));
    const log = await loadCollectorLog();
    const stamp = collectionStamp(rows, log);
    const summary = summarizePerformance(rows);
    return reply(req, res, 200, {
      brandId: brand?.id || '',
      brandLabel: screenBrandLabel(brand),
      summary,
      collectedAt: stamp.collectedAt,
      collectedAtSource: stamp.source,
      observedAt: stamp.observedAt,
      latestPublishedAt: summary.latestPublishedAt,
      collector: {
        lastRun: stamp.lastRun ? publicRun(stamp.lastRun) : null,
        lastSuccess: stamp.lastSuccess ? publicRun(stamp.lastSuccess) : null,
      },
      rows: rows.map(toClientRow),
    });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || String(e) });
  }
}

function brandFromBody(body) {
  const id = String(body.brandId || body.brand || '').trim();
  if (!id || id === 'all' || id === '전체') return null;
  return { id, name: body.brandName || '', ko: body.brandKo || '' };
}

function publicRun(row) {
  return {
    job: row.job || '',
    status: row.status || '',
    finishedAt: row.finished_at || '',
    posts: row.posts ?? null,
    error: row.error || '',
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
