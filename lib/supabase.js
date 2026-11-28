// Server-only Supabase access. The service role key never leaves this module.
// Brand tables stay in the `notion` schema (off the Data API). The app calls
// public views (security_invoker) after the cutover SQL is applied.

import { createHmac, randomUUID } from 'node:crypto';

export const BUCKET = 'notion-files';
const OBJECT_PREFIX = 'ddl-brand/';
// New uploads use ddl-brand/. Rows migrated from Notion keep the table name
// as the first folder in the same private bucket.
const STORAGE_PREFIXES = new Set([
  'ddl-brand',
  'content_calendar',
  'content_plans',
  'weekly_plan',
  'sales',
  'products',
  'costs',
  'action_plan',
  'app_settings',
  'references',
  'threads_performance',
  'daily_sales',
  'oem_inquiries_yj',
  'visit_stats_yj',
]);

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function requireConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) throw httpError(500, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return { url, key };
}

// sb_secret_ / sb_publishable_ keys are not JWTs. PostgREST and Storage return
// PGRST301 if they are also sent as Authorization: Bearer. Bearer stays for
// legacy service-role JWTs (eyJ...).
export function authHeaders(key) {
  const headers = { apikey: key };
  if (typeof key === 'string' && key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  return headers;
}

function errorMessage(data, fallback) {
  if (data && typeof data === 'object') return data.message || data.error || data.hint || fallback || 'supabase error';
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 300);
  return fallback || 'supabase error';
}

export async function rest(pathname, opts = {}) {
  const { url, key } = requireConfig();
  const u = new URL(url + '/rest/v1/' + pathname);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  const headers = { ...authHeaders(key), Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.prefer) headers.Prefer = opts.prefer;
  const r = await fetch(u, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await r.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!r.ok) {
    const err = httpError(502, errorMessage(data, r.statusText));
    err.upstream = r.status;
    throw err;
  }
  return data;
}

export async function restAll(view, query) {
  const out = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const rows = await rest(view, {
      query: { select: '*', order: 'created_time.asc', limit, offset, ...query },
    });
    const list = Array.isArray(rows) ? rows : [];
    out.push(...list);
    if (list.length < limit) break;
  }
  return out;
}

export function newId() {
  return randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUuid(v) {
  const s = String(v || '').trim();
  if (UUID_RE.test(s)) return s.toLowerCase();
  const n = s.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(n)) {
    return `${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20)}`.toLowerCase();
  }
  return null;
}

export function signJwt(payload, secret) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const h = enc({ alg: 'HS256', typ: 'JWT' });
  const b = enc(payload);
  const sig = createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${sig}`;
}

// Short-lived read-only token for Supabase Realtime. The browser never receives
// the service role key. SQL must create the brand_realtime role and SELECT
// policies before this token can see rows. Missing JWT secret => polling.
export function realtimeToken({ scope, brandName, allowFactory }) {
  const secret = String(process.env.SUPABASE_JWT_SECRET || '');
  const { url } = requireConfig();
  if (!secret) return { realtime: false, reason: 'SUPABASE_JWT_SECRET not set' };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 5 * 60;
  const token = signJwt({
    aud: 'authenticated',
    iss: 'supabase',
    role: 'brand_realtime',
    iat: now,
    exp,
    brand_scope: scope === 'all' ? 'all' : 'one',
    brand_name: brandName || '',
    allow_factory: allowFactory ? 'true' : 'false',
  }, secret);
  const anon = String(process.env.SUPABASE_ANON_KEY || '');
  return {
    realtime: true,
    token,
    url,
    anonKey: anon || token,
    expiresIn: 300,
  };
}

function safeName(filename) {
  const base = String(filename || 'upload').split(/[/\\]/).pop();
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return clean || 'upload';
}

export function uploadObjectPath(filename) {
  return OBJECT_PREFIX + newId() + '/' + safeName(filename);
}

const SAFE_SEG = /^[A-Za-z0-9._-]{1,180}$/;

export function storagePathFromId(id) {
  if (id == null) return null;
  let p = String(id).trim();
  if (!p) return null;
  if (p.startsWith('notion-files/')) p = p.slice('notion-files/'.length);
  p = p.replace(/^\/+/, '');
  if (p.includes('..') || p.includes('\\') || p.includes('\0') || p.includes('?') || p.includes('#') || p.includes('//')) return null;
  const parts = p.split('/');
  if (parts.length !== 3) return null;
  const [prefix, folder, file] = parts;
  if (!STORAGE_PREFIXES.has(prefix)) return null;
  if (!SAFE_SEG.test(folder) || !SAFE_SEG.test(file)) return null;
  return 'notion-files/' + prefix + '/' + folder + '/' + file;
}

function objectUrl(objectPath) {
  const { url } = requireConfig();
  const safe = storagePathFromId(objectPath);
  if (!safe) throw httpError(400, 'bad path');
  const rel = safe.slice('notion-files/'.length);
  return url + '/storage/v1/object/' + BUCKET + '/' + rel.split('/').map(encodeURIComponent).join('/');
}

export async function uploadObject(objectPath, bytes, contentType) {
  const { key } = requireConfig();
  const r = await fetch(objectUrl(objectPath), {
    method: 'POST',
    headers: {
      ...authHeaders(key),
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
      'cache-control': 'private, max-age=3600',
    },
    body: bytes,
  });
  if (!r.ok) {
    const t = await r.text();
    const err = httpError(502, 'storage upload failed');
    err.detail = t.slice(0, 300);
    throw err;
  }
}

export async function signObject(objectPath) {
  const { url, key } = requireConfig();
  const safe = storagePathFromId(objectPath);
  if (!safe) return '';
  const rel = safe.slice('notion-files/'.length);
  const u = url + '/storage/v1/object/sign/' + BUCKET + '/' + rel.split('/').map(encodeURIComponent).join('/');
  const r = await fetch(u, {
    method: 'POST',
    headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!r.ok) return '';
  const data = await r.json().catch(() => ({}));
  const signed = data.signedURL || data.signedUrl || '';
  if (!signed) return '';
  if (/^https?:\/\//i.test(signed)) return signed;
  return url + '/storage/v1' + (signed.startsWith('/') ? signed : '/' + signed);
}
