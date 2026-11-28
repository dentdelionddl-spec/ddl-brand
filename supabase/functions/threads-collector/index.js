// Supabase Edge Function. Cron calls this with the service role key.
// verify_jwt is off because the key may be an sb_secret rather than a JWT.
// The checks below are the lock: the service role key, or the cron secret. Publishing and reply automation are not here.

import { createHash, timingSafeEqual } from 'node:crypto';
import { runJob } from './job.js';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ message: 'POST만 받습니다' }, 405);
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const got = bearer(req);
  if (!expected || !got || !(sameSecret(got, expected) || await cronSecretOk(got, expected))) {
    return json({ message: '인증이 필요합니다' }, 401);
  }
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const job = String(body.job || '');
  try {
    const result = await runJob(job, {
      env: envObject(),
      now: new Date(),
    });
    return json({ ok: result.ok !== false, job, status: result.status || 'ok', posts: result.posts || 0, brands: result.brands || 0 });
  } catch (error) {
    return json({ ok: false, message: String(error?.message || error).slice(0, 300) }, 500);
  }
});

function bearer(req) {
  const header = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function sameSecret(a, b) {
  const hash = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(hash(a), hash(b));
}

// pg_cron calls with the Vault secret THREADS_COLLECTOR_SECRET, so the
// service role key never has to be copied into Vault. The check runs in the
// database (public.threads_collector_auth, service role only).
async function cronSecretOk(got, serviceKey) {
  const base = String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  if (!base) return false;
  const headers = { apikey: serviceKey, 'Content-Type': 'application/json' };
  if (serviceKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + serviceKey;
  try {
    const res = await fetch(base + '/rest/v1/rpc/threads_collector_auth', {
      method: 'POST', headers, body: JSON.stringify({ p_secret: got }),
    });
    return res.ok && (await res.json()) === true;
  } catch { return false; }
}

function envObject() {
  const out = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) out[key] = value;
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
