// DDL 브랜드 관리 — 노션 프록시 (Vercel 서버리스 함수)
//
// 필요한 환경변수
//   NOTION_TOKEN  노션 인테그레이션 토큰
//   ADMIN_KEY     관리자 비밀번호 (운영 사이트 설정 화면에 같은 값을 넣음)
// 선택 환경변수
//   ALLOW_ORIGIN  CORS 허용 주소, 쉼표로 여러 개 (기본: 운영 도메인)
//   EXTRA_DB_IDS  아래 목록 밖의 DB를 더 쓸 때, 쉼표로 구분
//
// 권한은 세 단계입니다.
//   관리자  X-Admin-Key 헤더 = ADMIN_KEY      → 허용 DB 안에서 모든 동작
//   공유    X-Share-Key 헤더 = 브랜드 공유키  → 그 브랜드 행만 읽기 (?s= 링크)
//   임베드  X-Embed-Brand 헤더 = 브랜드       → 그 브랜드의 일정·업무·기획만 읽기 (?embed= 화면)

import { createHash, timingSafeEqual } from 'node:crypto';

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const UPLOAD_VERSION = '2025-09-03';
const DEFAULT_ORIGIN = 'https://ddl-brand.vercel.app';

/* index.html의 NOTION_DB · INQ_DB · TRAFFIC_DB와 같은 값 */
const DBS = {
  contents: '22c3381ad8e44f239be74fdd3243eba3',
  tasks:    '1b390d2a35db48d796e26edaa0834a6a',
  sales:    '5ca27a6560214303bc77b2da9e48ce02',
  products: 'ddd18f71b6c9475abc59f74881cff410',
  plans:    '30a5544647d84123b4ad5e106c48c64e',
  costs:    'e33ee267da7d43fd86f72c28fa888114',
  actions:  '21f72c37590f48dba49455f0c705b4ab',
  config:   '46b8ab2d1ddc47f7b5f8c0bfa4748ab9',
  refs:     'ae4c78c3a8324090b2617774d9ae3f01',
  stats:    '691bda8c1aec4253964f2adda0e18c05',
  inquiries:'b400cf41ae804765b1b15e3a4b004ba1',
  traffic:  '22b96ecfb203408295a3f8755c6935b6',
};
/* 공유·임베드에서 브랜드별로 걸러 읽을 수 있는 DB */
const SHARE_DBS = ['contents', 'tasks', 'sales', 'products', 'plans', 'costs', 'actions', 'refs', 'stats'];
const EMBED_DBS = ['contents', 'tasks', 'plans'];
/* 문의·유입 DB는 공장 브랜드 공유에서만, 문의는 집계용 속성만 */
const TRAFFIC_BRAND = 'factory';
const INQ_PROPS = ['접수일시', '유입 경로', '진행 상태'];

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  const allowed = (process.env.ALLOW_ORIGIN || DEFAULT_ORIGIN).split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, X-Share-Key, X-Embed-Brand');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST만 받습니다' });
  if (!process.env.NOTION_TOKEN)
    return res.status(500).json({ message: 'NOTION_TOKEN 환경변수가 설정되지 않았습니다' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  if (!body) return res.status(400).json({ message: '요청 본문이 JSON이 아닙니다' });

  const head = {
    Authorization: 'Bearer '+process.env.NOTION_TOKEN,
    'Notion-Version': VERSION,
    'Content-Type': 'application/json',
  };

  try {
    const { action } = body;
    const who = await authorize(req, head);
    if (who.error) return res.status(who.status).json({ message: who.error });

    /* 공유·임베드: 허용된 DB 조회만 */
    if (who.scope) {
      if (action !== 'query') return res.status(401).json({ message: '보기 전용 링크에서는 조회만 할 수 있습니다' });
      const name = dbName(body.database_id);
      if (!name || !scopeAllows(who, name)) return res.status(403).json({ message: '이 링크로는 볼 수 없는 DB입니다' });
      const r = await queryAll(head, DBS[name], body);
      if (r.error) return res.status(r.status).json({ message: r.error });
      return res.status(200).json({ results: scopeRows(who, name, r.results) });
    }

    if (action === 'ping') return res.status(200).json({ ok: true });

    if (action === 'upload') {
      const { filename, content_type, data } = body;
      if (!data) return res.status(400).json({ message: '파일 데이터가 없습니다' });
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > 9 * 1024 * 1024)
        return res.status(413).json({ message: '파일이 너무 큽니다 (9MB 이하)' });

      const uh = {
        Authorization: 'Bearer '+process.env.NOTION_TOKEN,
        'Notion-Version': UPLOAD_VERSION,
      };
      const c = await fetch(NOTION+'/file_uploads', {
        method: 'POST',
        headers: { ...uh, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: filename || 'upload', content_type: content_type || 'application/octet-stream' }),
      });
      const created = await c.json();
      if (!c.ok) return res.status(c.status).json({ message: created.message || '업로드 준비 실패' });

      const form = new FormData();
      form.append('file', new Blob([bytes], { type: content_type || 'application/octet-stream' }), filename || 'upload');
      const s = await fetch(created.upload_url || NOTION+'/file_uploads/'+created.id+'/send', {
        method: 'POST', headers: uh, body: form,
      });
      const sent = await s.json();
      if (!s.ok) return res.status(s.status).json({ message: sent.message || '업로드 전송 실패' });
      return res.status(200).json({ id: created.id, filename: filename || 'upload', status: sent.status });
    }

    if (action === 'query') {
      const { database_id } = body;
      if (!database_id) return res.status(400).json({ message: 'database_id가 없습니다' });
      if (!isAllowedDb(database_id)) return res.status(403).json({ message: '허용되지 않은 DB입니다' });
      const r = await queryAll(head, database_id, body);
      if (r.error) return res.status(r.status).json({ message: r.error });
      return res.status(200).json({ results: r.results });
    }

    if (action === 'create') {
      const { database_id, properties } = body;
      if (!database_id) return res.status(400).json({ message: 'database_id가 없습니다' });
      if (!isAllowedDb(database_id)) return res.status(403).json({ message: '허용되지 않은 DB입니다' });
      return pass(res, NOTION+'/pages', {
        method: 'POST', headers: head,
        body: JSON.stringify({ parent: { database_id }, properties }),
      });
    }

    if (action === 'update' || action === 'delete') {
      const { page_id, properties } = body;
      if (!page_id) return res.status(400).json({ message: 'page_id가 없습니다' });
      const p = await fetch(NOTION+'/pages/'+encodeURIComponent(page_id), { headers: head });
      const pg = await p.json();
      if (!p.ok) return res.status(p.status).json({ message: pg.message || '페이지를 찾지 못했습니다' });
      if (!isAllowedDb(pg.parent?.database_id)) return res.status(403).json({ message: '허용되지 않은 DB의 페이지입니다' });
      return pass(res, NOTION+'/pages/'+encodeURIComponent(page_id), {
        method: 'PATCH', headers: head,
        body: JSON.stringify(action === 'delete' ? { archived: true } : { properties }),
      });
    }

    if (action === 'schema') {
      const { database_id } = body;
      if (!isAllowedDb(database_id)) return res.status(403).json({ message: '허용되지 않은 DB입니다' });
      return pass(res, NOTION+'/databases/'+database_id, { method: 'GET', headers: head });
    }

    return res.status(400).json({ message: '모르는 action: '+action });
  } catch (e) {
    return res.status(500).json({ message: String(e) });
  }
}

/* ---------- 권한 ---------- */
async function authorize(req, head) {
  const admin = header(req, 'x-admin-key');
  if (admin) {
    if (!process.env.ADMIN_KEY) return { status: 500, error: 'ADMIN_KEY 환경변수가 설정되지 않았습니다' };
    return sameSecret(admin, process.env.ADMIN_KEY) ? { admin: true } : { status: 401, error: '관리자 비밀번호가 맞지 않습니다' };
  }
  const share = header(req, 'x-share-key');
  const embed = header(req, 'x-embed-brand').toLowerCase();
  if (!share && !embed) return { status: 401, error: '관리자 비밀번호가 필요합니다' };

  const brands = await loadBrands(head);
  if (share) {
    const b = brands.find(x => x.shareKey && sameSecret(share, x.shareKey));
    return b ? { scope: 'share', brand: b } : { status: 401, error: '공유가 해제됐거나 주소가 바뀌었습니다' };
  }
  const n = normName(embed);
  const b = brands.find(x => String(x.id).toLowerCase() === embed || normName(x.name) === n);
  return b ? { scope: 'embed', brand: b } : { status: 403, error: '없는 브랜드입니다' };
}

function scopeAllows(who, name) {
  if (name === 'config') return true;
  if (name === 'inquiries' || name === 'traffic') return who.scope === 'share' && who.brand.id === TRAFFIC_BRAND;
  return (who.scope === 'share' ? SHARE_DBS : EMBED_DBS).includes(name);
}

/* 브랜드 행만 남기고, 설정 DB는 그 브랜드 하나만 담은 brands 행으로 바꿈 */
function scopeRows(who, name, rows) {
  if (name === 'traffic') return rows;
  if (name === 'inquiries') return rows.map(p => ({ id: p.id, properties: pick(p.properties, INQ_PROPS) }));
  if (name === 'config') {
    const { shareKey, ...rest } = who.brand;
    const one = JSON.stringify([who.scope === 'share' ? who.brand : rest]);
    return rows.filter(p => titleOf(p.properties?.['항목']) === 'brands').map(p => ({
      id: p.id,
      properties: { '항목': p.properties['항목'], '값': { rich_text: [{ type: 'text', text: { content: one }, plain_text: one }] } },
    }));
  }
  const keys = [who.brand.name, who.brand.ko, ...(who.brand.aliases || [])].map(normName).filter(Boolean);
  return rows.filter(p => {
    const P = p.properties || {};
    const v = normName((P['브랜드'] || P['Brand'])?.select?.name);
    return v && keys.includes(v);
  });
}

let brandCache = { at: 0, list: [] };
async function loadBrands(head) {
  if (Date.now() - brandCache.at < 60_000) return brandCache.list;
  const r = await queryAll(head, DBS.config, {});
  if (r.error) throw new Error('브랜드 목록을 읽지 못했습니다: '+r.error);
  const row = r.results.find(p => titleOf(p.properties?.['항목']) === 'brands');
  const raw = (row?.properties?.['값']?.rich_text || []).map(t => t.plain_text).join('');
  let list = [];
  try { list = JSON.parse(raw); } catch {}
  brandCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
  return brandCache.list;
}

/* ---------- 도우미 ---------- */
async function queryAll(head, database_id, { filter, sorts, page_size }) {
  let results = [];
  let cursor;
  do {
    const r = await fetch(NOTION+'/databases/'+database_id+'/query', {
      method: 'POST',
      headers: head,
      body: JSON.stringify({ filter, sorts, page_size: page_size || 100, start_cursor: cursor }),
    });
    const d = await r.json();
    if (!r.ok) return { status: r.status, error: d.message || '노션 조회 실패' };
    results = results.concat(d.results || []);
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return { results };
}

const normId = id => String(id || '').replace(/-/g, '').toLowerCase();
function dbName(id) {
  const n = normId(id);
  return Object.keys(DBS).find(k => DBS[k] === n) || null;
}
function isAllowedDb(id) {
  const n = normId(id);
  if (!n) return false;
  const extra = (process.env.EXTRA_DB_IDS || '').split(',').map(normId).filter(Boolean);
  return Object.values(DBS).includes(n) || extra.includes(n);
}

function header(req, name) {
  const v = String(Array.isArray(req.headers[name]) ? req.headers[name][0] : req.headers[name] || '').trim();
  /* 브라우저가 한글 비밀번호를 인코딩해 보냄 — 인코딩 안 된 옛 값도 그대로 통과 */
  try { return decodeURIComponent(v); } catch { return v; }
}
function sameSecret(a, b) {
  /* 앞뒤 공백, 맥/윈도 한글 조합 방식(NFD/NFC) 차이는 같은 값으로 봄 */
  const h = s => createHash('sha256').update(String(s).normalize('NFC').trim()).digest();
  return timingSafeEqual(h(a), h(b));
}
const normName = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[\s\-_.()（）]/g, '');
const titleOf = p => (p?.title || []).map(t => t.plain_text).join('');
function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj && k in obj) o[k] = obj[k];
  return o;
}

async function pass(res, url, init) {
  const r = await fetch(url, init);
  const d = await r.json();
  return res.status(r.status).json(d);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
