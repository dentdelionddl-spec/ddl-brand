// DDL 브랜드 관리 — 브랜드별 공개 일정
//
// GET  /api/schedule?brand=vivicate
// POST /api/schedule?brand=vivicate   { action: create|update|delete }
// 외부 사이트용. 메모·첨부·담당자는 내보내지 않습니다.
// 업무는 보기만 됩니다. 저장은 Supabase content_calendar / weekly_plan.

import { archiveRow, createRow, listRows, updateRow } from '../lib/pages.js';

const CATEGORIES = ['피드', '릴스', '스레드', '제품 업로드', '제품 입고', '공구', '기획전', '오프라인', 'EGC', '온라인', '이벤트', 'UGC'];
const PUBLIC_BRANDS = {
  vivicate: { name: 'VIVICATE' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ message: 'GET·POST만 받습니다' });

  const brand = String(req.query?.brand || '').toLowerCase();
  const conf = PUBLIC_BRANDS[brand];
  if (!conf) return res.status(404).json({ message: '공개되지 않은 브랜드입니다' });

  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ brand, updatedAt: new Date().toISOString(), items: await list(conf) });
    }
    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
    if (!body) return res.status(400).json({ message: '요청 본문이 JSON이 아닙니다' });
    const { action, id } = body;

    if (action === 'create') {
      const props = toProps(body.item || {}, true);
      if (props.error) return res.status(400).json({ message: props.error });
      props['브랜드'] = { select: { name: conf.name } };
      const page = await createRow('contents', props);
      return res.status(200).json({ item: toItem(page) });
    }

    if (action === 'update' || action === 'delete') {
      if (!id) return res.status(400).json({ message: 'id가 없습니다' });
      const pages = await listRows('contents', {});
      const cur = pages.find((p) => p.id === id || String(p.id).replace(/-/g, '') === String(id).replace(/-/g, ''));
      if (!cur || cur.archived) return res.status(404).json({ message: '없는 일정입니다' });
      if (cur.properties?.['브랜드']?.select?.name !== conf.name) return res.status(403).json({ message: '이 브랜드 일정이 아닙니다' });
      if (action === 'delete') {
        await archiveRow('contents', cur.id);
        return res.status(200).json({ ok: true });
      }
      const props = toProps({ ...fromPage(cur), ...(body.item || {}) }, false);
      if (props.error) return res.status(400).json({ message: props.error });
      props['브랜드'] = { select: { name: conf.name } };
      const page = await updateRow('contents', cur.id, props);
      return res.status(200).json({ item: toItem(page) });
    }
    return res.status(400).json({ message: '모르는 action: ' + action });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || String(e) });
  }
}

async function list(conf) {
  const [contents, tasks] = await Promise.all([
    listRows('contents', {}),
    listRows('tasks', {}),
  ]);
  const items = [
    ...contents.filter((p) => !p.archived && p.properties?.['브랜드']?.select?.name === conf.name && p.properties?.['날짜']?.date?.start).map(toItem),
    ...tasks.filter((p) => !p.archived && (p.properties?.['Brand']?.select?.name === conf.name) && p.properties?.['Due']?.date?.start).map(toTask),
  ];
  return items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function toTask(pg) {
  const P = pg.properties || {};
  const d = P['Due'].date;
  const today = kstToday();
  const date = d.start.slice(0, 10);
  const end = d.end ? d.end.slice(0, 10) : null;
  const done = (P['Status']?.status?.name || P['Status']?.select?.name) === 'Done';
  const status = done ? '완료' : (date <= today && (end || date) >= today ? '진행중' : '예정');
  return {
    id: pg.id, kind: 'task', date, endDate: end && end !== date ? end : null,
    title: (P['Task']?.title || []).map((t) => t.plain_text).join(''), category: '업무', done, status,
    owners: (P['담당자']?.multi_select || []).map((o) => o.name),
    area: P['영역']?.select?.name || '',
    memo: (P['상세']?.rich_text || []).map((t) => t.plain_text).join(''),
  };
}

function fromPage(pg) {
  const P = pg.properties || {};
  const d = P['날짜']?.date || {};
  return {
    title: (P['제목']?.title || []).map((t) => t.plain_text).join(''),
    date: d.start ? d.start.slice(0, 10) : '',
    endDate: d.end ? d.end.slice(0, 10) : null,
    category: P['유형']?.select?.name || '',
    done: !!P['완료']?.checkbox,
  };
}

function toItem(pg) {
  const f = fromPage(pg);
  const today = kstToday();
  const status = f.done ? '완료' : (f.date <= today && (f.endDate || f.date) >= today ? '진행중' : '예정');
  return {
    id: pg.id, kind: 'schedule', date: f.date, endDate: f.endDate && f.endDate !== f.date ? f.endDate : null,
    title: f.title, category: f.category, done: f.done, status,
  };
}

function toProps(it, creating) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const titleText = String(it.title || '').trim();
  if (!titleText) return { error: '제목을 입력하세요' };
  if (!day.test(it.date || '')) return { error: '날짜 형식이 맞지 않습니다' };
  const end = it.endDate && it.endDate !== it.date ? it.endDate : null;
  if (end && (!day.test(end) || end < it.date)) return { error: '종료일이 시작일보다 빠릅니다' };
  if (it.category && !CATEGORIES.includes(it.category)) return { error: '없는 구분입니다' };
  return {
    '제목': { title: [{ plain_text: titleText.slice(0, 200), text: { content: titleText.slice(0, 200) } }] },
    '날짜': { date: { start: it.date, ...(end ? { end } : {}) } },
    ...(it.category ? { '유형': { select: { name: it.category } } } : (creating ? {} : { '유형': { select: null } })),
    '완료': { checkbox: !!it.done },
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
