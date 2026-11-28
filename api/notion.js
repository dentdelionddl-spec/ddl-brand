// DDL 브랜드 관리 — Supabase 저장 API (Vercel 서버리스 함수)
//
// 브라우저의 요청 모양(query / create / update / delete / upload)은 그대로입니다.
// 데이터는 notion 스키마의 테이블에 있고, 이 함수만 서비스 롤로 읽습니다.
//
// 필요한 환경변수
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_KEY
// 선택
//   ALLOW_ORIGIN
//   SUPABASE_JWT_SECRET   실시간 구독용 짧은 JWT. 없으면 8초 폴링
//   SUPABASE_ANON_KEY     브라우저 Realtime 연결용 공개 키. 서비스 롤이 아님

import { createHash, timingSafeEqual } from 'node:crypto';
import { realtimeToken } from '../lib/supabase.js';
import {
  TABLES, archiveRow, createRow, findRow, listRows, tableKey, updateRow, uploadFile,
} from '../lib/pages.js';

const DEFAULT_ORIGIN = 'https://ddl-brand.vercel.app';
const SHARE_DBS = ['contents', 'tasks', 'sales', 'products', 'plans', 'costs', 'actions', 'refs', 'stats', 'daily'];
const EMBED_DBS = ['contents', 'tasks', 'plans'];
const TRAFFIC_BRAND = 'factory';
const INQ_PROPS = ['접수일시', '유입 경로', '진행 상태'];

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

let brandCache = { at: 0, list: [] };
export function resetAuthCache() { brandCache = { at: 0, list: [] }; }

export default async function handler(req, res) {
  const allowed = (process.env.ALLOW_ORIGIN || DEFAULT_ORIGIN).split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, X-Share-Key, X-Embed-Brand');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST만 받습니다' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  if (!body) return res.status(400).json({ message: '요청 본문이 JSON이 아닙니다' });

  try {
    const { action } = body;
    const who = await authorize(req);
    if (who.error) return res.status(who.status).json({ message: who.error });

    if (action === 'ping' || action === 'clock') {
      return res.status(200).json({ ok: true, now: new Date().toISOString() });
    }

    if (action === 'realtime') {
      const token = realtimeToken({
        scope: who.scope ? 'one' : 'all',
        brandName: who.brand?.name || '',
        allowFactory: !who.scope || who.brand?.id === TRAFFIC_BRAND,
      });
      return res.status(200).json(token);
    }

    if (who.scope && action !== 'query' && action !== 'changes') {
      return res.status(401).json({ message: '보기 전용 링크에서는 조회만 할 수 있습니다' });
    }

    if (action === 'query') {
      const key = tableKey(body.database_id);
      if (!key || (who.scope && !scopeAllows(who, key))) return res.status(403).json({ message: '이 링크로는 볼 수 없는 DB입니다' });
      const pages = await listRows(key, {});
      const results = who.scope ? scopeRows(who, key, pages) : pages;
      return res.status(200).json({ results });
    }

    if (action === 'changes') {
      const since = body.since ? String(body.since) : '';
      const keys = Object.keys(TABLES).filter((key) => !who.scope || scopeAllows(who, key));
      const upserts = {};
      const deleted = {};
      await Promise.all(keys.map(async (key) => {
        const pages = await listRows(key, since ? { since } : {});
        const live = pages.filter((p) => !p.archived);
        const gone = pages.filter((p) => p.archived);
        upserts[key] = who.scope ? scopeRows(who, key, live) : live;
        deleted[key] = (who.scope ? scopeRows(who, key, gone) : gone).map((p) => p.id);
      }));
      return res.status(200).json({ now: new Date().toISOString(), upserts, deleted });
    }

    if (action === 'upload') {
      const { filename, content_type, data } = body;
      if (!data) return res.status(400).json({ message: '파일 데이터가 없습니다' });
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > 9 * 1024 * 1024) return res.status(413).json({ message: '파일이 너무 큽니다 (9MB 이하)' });
      const saved = await uploadFile({ filename, contentType: content_type, bytes });
      return res.status(200).json(saved);
    }

    if (action === 'create') {
      const key = tableKey(body.database_id);
      if (!key) return res.status(403).json({ message: '허용되지 않은 DB입니다' });
      const page = await createRow(key, body.properties || {});
      return res.status(200).json(page);
    }

    if (action === 'update' || action === 'delete') {
      if (!body.page_id) return res.status(400).json({ message: 'page_id가 없습니다' });
      const found = await findRow(body.page_id, Object.keys(TABLES));
      if (!found) return res.status(404).json({ message: '페이지를 찾지 못했습니다' });
      if (action === 'delete') {
        await archiveRow(found.key, found.id);
        return res.status(200).json({ ok: true, id: found.id });
      }
      const page = await updateRow(found.key, found.id, body.properties || {});
      return res.status(200).json(page);
    }

    if (action === 'schema') {
      const key = tableKey(body.database_id);
      if (!key) return res.status(403).json({ message: '허용되지 않은 DB입니다' });
      return res.status(200).json({ object: 'database', id: TABLES[key].id });
    }

    return res.status(400).json({ message: '모르는 action: ' + action });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ message: e.message || String(e) });
  }
}

async function authorize(req) {
  const admin = header(req, 'x-admin-key');
  if (admin) {
    if (!process.env.ADMIN_KEY) return { status: 500, error: 'ADMIN_KEY 환경변수가 설정되지 않았습니다' };
    return sameSecret(admin, process.env.ADMIN_KEY) ? { admin: true } : { status: 401, error: '관리자 비밀번호가 맞지 않습니다' };
  }
  const share = header(req, 'x-share-key');
  const embed = header(req, 'x-embed-brand').toLowerCase();
  if (!share && !embed) return { status: 401, error: '관리자 비밀번호가 필요합니다' };

  const brands = await loadBrands();
  if (share) {
    const b = brands.find((x) => x.shareKey && sameSecret(share, x.shareKey));
    return b ? { scope: 'share', brand: b } : { status: 401, error: '공유가 해제됐거나 주소가 바뀌었습니다' };
  }
  const n = normName(embed);
  const b = brands.find((x) => String(x.id).toLowerCase() === embed || normName(x.name) === n);
  return b ? { scope: 'embed', brand: b } : { status: 403, error: '없는 브랜드입니다' };
}

async function loadBrands() {
  if (Date.now() - brandCache.at < 60_000) return brandCache.list;
  const pages = await listRows('config', {});
  const row = pages.find((p) => titleOf(p.properties?.['항목']) === 'brands');
  const raw = (row?.properties?.['값']?.rich_text || []).map((t) => t.plain_text).join('');
  let list = [];
  try { list = JSON.parse(raw); } catch { list = []; }
  brandCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
  return brandCache.list;
}

function scopeAllows(who, name) {
  if (name === 'config') return true;
  if (name === 'inquiries' || name === 'traffic') return who.scope === 'share' && who.brand.id === TRAFFIC_BRAND;
  return (who.scope === 'share' ? SHARE_DBS : EMBED_DBS).includes(name);
}

function scopeRows(who, name, rows) {
  if (name === 'traffic') return rows;
  if (name === 'inquiries') return rows.map((p) => ({ id: p.id, properties: pick(p.properties, INQ_PROPS) }));
  if (name === 'config') {
    const { shareKey, ...rest } = who.brand;
    const one = JSON.stringify([who.scope === 'share' ? who.brand : rest]);
    return rows.filter((p) => titleOf(p.properties?.['항목']) === 'brands').map((p) => ({
      id: p.id,
      properties: {
        '항목': p.properties['항목'],
        '값': { rich_text: [{ type: 'text', text: { content: one }, plain_text: one }] },
      },
    }));
  }
  const keys = [who.brand.name, who.brand.ko, ...(who.brand.aliases || [])].map(normName).filter(Boolean);
  return rows.filter((p) => {
    const P = p.properties || {};
    const v = normName((P['브랜드'] || P['Brand'])?.select?.name);
    return v && keys.includes(v);
  });
}

function header(req, name) {
  const v = String(Array.isArray(req.headers[name]) ? req.headers[name][0] : req.headers[name] || '').trim();
  try { return decodeURIComponent(v); } catch { return v; }
}
function sameSecret(a, b) {
  const h = (s) => createHash('sha256').update(String(s).normalize('NFC').trim()).digest();
  return timingSafeEqual(h(a), h(b));
}
const normName = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[\s\-_.()（）]/g, '');
const titleOf = (p) => (p?.title || []).map((t) => t.plain_text).join('');
function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj && k in obj) o[k] = obj[k];
  return o;
}
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
