// DDL 브랜드 관리 — 브랜드별 공개 일정 (Vercel 서버리스 함수)
//
// GET  /api/schedule?brand=vivicate          그 브랜드 일정 보기 (비밀번호 없음)
// POST /api/schedule?brand=vivicate          추가·수정·삭제 (비밀번호 없음 — 그 브랜드 일정만, 삭제는 노션 휴지통으로)
//      { action:'create', item:{title,date,endDate,category,done} }
//      { action:'update', id, item:{…바꿀 것만} }
//      { action:'delete', id }
// 외부 사이트(ek-oem 등)용이라 메모·첨부·담당자는 내보내지도, 고치지도 않습니다.
// 업무 DB(주간 플랜)의 그 브랜드 업무는 담당자·영역·상세까지 함께 내보내되(kind:'task'), 보기만 하고 고칠 수는 없습니다.
// 필요한 환경변수: NOTION_TOKEN

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const CONTENTS_DB = '22c3381ad8e44f239be74fdd3243eba3';
const TASKS_DB = '1b390d2a35db48d796e26edaa0834a6a';

/* 공개를 허용한 브랜드만 (주소 값 → 노션 '브랜드' 선택값) */
const PUBLIC_BRANDS = {
  vivicate: { name: 'VIVICATE' },
};
/* 노션 '유형' 선택지와 같은 값만 받음 */
const CATEGORIES = ['피드', '릴스', '스레드', '제품 업로드', '제품 입고', '공구', '기획전', '오프라인', 'EGC', '온라인', '이벤트', 'UGC'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ message: 'GET·POST만 받습니다' });

  const brand = String(req.query.brand || '').toLowerCase();
  const conf = PUBLIC_BRANDS[brand];
  if (!conf) return res.status(404).json({ message: '공개되지 않은 브랜드입니다' });
  if (!process.env.NOTION_TOKEN)
    return res.status(500).json({ message: 'NOTION_TOKEN 환경변수가 설정되지 않았습니다' });

  /* 운영페이지에서 고친 내용이 바로 보이도록 캐시하지 않음 */
  res.setHeader('Cache-Control', 'no-store');
  const head = {
    Authorization: 'Bearer '+process.env.NOTION_TOKEN,
    'Notion-Version': VERSION,
    'Content-Type': 'application/json',
  };

  try {
    if (req.method === 'GET') return res.status(200).json({ brand, updatedAt: new Date().toISOString(), items: await list(head, conf) });

    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
    if (!body) return res.status(400).json({ message: '요청 본문이 JSON이 아닙니다' });
    const { action, id } = body;

    if (action === 'create') {
      const props = toProps(body.item || {}, true);
      if (props.error) return res.status(400).json({ message: props.error });
      const r = await notion(head, '/pages', 'POST', {
        parent: { database_id: CONTENTS_DB },
        properties: { ...props, '브랜드': { select: { name: conf.name } } },
      });
      if (r.error) return res.status(502).json({ message: r.error });
      return res.status(200).json({ item: toItem(r.data) });
    }

    if (action === 'update' || action === 'delete') {
      if (!id) return res.status(400).json({ message: 'id가 없습니다' });
      /* 그 브랜드 일정 DB의 행인지 먼저 확인 — 다른 브랜드·다른 DB는 못 건드림 */
      const cur = await notion(head, '/pages/'+id, 'GET');
      if (cur.error) return res.status(404).json({ message: '없는 일정입니다' });
      const pg = cur.data;
      if (pg.archived || String(pg.parent?.database_id || '').replace(/-/g, '') !== CONTENTS_DB
          || pg.properties?.['브랜드']?.select?.name !== conf.name)
        return res.status(403).json({ message: '이 브랜드 일정이 아닙니다' });

      if (action === 'delete') {
        const r = await notion(head, '/pages/'+id, 'PATCH', { archived: true });
        if (r.error) return res.status(502).json({ message: r.error });
        return res.status(200).json({ ok: true });
      }
      const props = toProps({ ...fromPage(pg), ...(body.item || {}) }, false);
      if (props.error) return res.status(400).json({ message: props.error });
      const r = await notion(head, '/pages/'+id, 'PATCH', { properties: props });
      if (r.error) return res.status(502).json({ message: r.error });
      return res.status(200).json({ item: toItem(r.data) });
    }

    return res.status(400).json({ message: '모르는 action: '+action });
  } catch (e) {
    return res.status(500).json({ message: String(e) });
  }
}

async function list(head, conf) {
  const [contents, tasks] = await Promise.all([
    queryAll(head, CONTENTS_DB, { property: '브랜드', select: { equals: conf.name } }),
    queryAll(head, TASKS_DB, { property: 'Brand', select: { equals: conf.name } }),
  ]);
  return [
    ...contents.filter(pg => pg.properties?.['날짜']?.date?.start).map(toItem),
    ...tasks.filter(pg => pg.properties?.['Due']?.date?.start).map(toTask),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

async function queryAll(head, db, filter) {
  let pages = [];
  let cursor;
  do {
    const r = await notion(head, '/databases/'+db+'/query', 'POST', { filter, page_size: 100, start_cursor: cursor });
    if (r.error) throw new Error(r.error);
    pages = pages.concat(r.data.results || []);
    cursor = r.data.has_more ? r.data.next_cursor : null;
  } while (cursor);
  return pages;
}

/* 업무: 제목·기간·완료·담당자·영역·상세 */
function toTask(pg) {
  const P = pg.properties || {};
  const d = P['Due'].date, today = kstToday();
  const date = d.start.slice(0, 10), end = d.end ? d.end.slice(0, 10) : null;
  const done = (P['Status']?.status?.name || P['Status']?.select?.name) === 'Done';
  const status = done ? '완료' : (date <= today && (end || date) >= today ? '진행중' : '예정');
  return { id: pg.id, kind: 'task', date, endDate: end && end !== date ? end : null,
    title: (P['Task']?.title || []).map(t => t.plain_text).join(''), category: '업무', done, status,
    owners: (P['담당자']?.multi_select || []).map(o => o.name),
    area: P['영역']?.select?.name || '',
    memo: (P['상세']?.rich_text || []).map(t => t.plain_text).join('') };
}

function fromPage(pg) {
  const P = pg.properties || {};
  const d = P['날짜']?.date || {};
  return {
    title: (P['제목']?.title || []).map(t => t.plain_text).join(''),
    date: d.start ? d.start.slice(0, 10) : '',
    endDate: d.end ? d.end.slice(0, 10) : null,
    category: P['유형']?.select?.name || '',
    done: !!P['완료']?.checkbox,
  };
}

function toItem(pg) {
  const f = fromPage(pg), today = kstToday();
  const status = f.done ? '완료' : (f.date <= today && (f.endDate || f.date) >= today ? '진행중' : '예정');
  return { id: pg.id, kind: 'schedule', date: f.date, endDate: f.endDate && f.endDate !== f.date ? f.endDate : null,
    title: f.title, category: f.category, done: f.done, status };
}

function toProps(it, creating) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const title = String(it.title || '').trim();
  if (!title) return { error: '제목을 입력하세요' };
  if (!day.test(it.date || '')) return { error: '날짜 형식이 맞지 않습니다' };
  const end = it.endDate && it.endDate !== it.date ? it.endDate : null;
  if (end && (!day.test(end) || end < it.date)) return { error: '종료일이 시작일보다 빠릅니다' };
  if (it.category && !CATEGORIES.includes(it.category)) return { error: '없는 구분입니다' };
  return {
    '제목': { title: [{ text: { content: title.slice(0, 200) } }] },
    '날짜': { date: { start: it.date, ...(end ? { end } : {}) } },
    ...(it.category ? { '유형': { select: { name: it.category } } } : (creating ? {} : { '유형': { select: null } })),
    '완료': { checkbox: !!it.done },
  };
}

async function notion(head, path, method, body) {
  const r = await fetch(NOTION+path, { method, headers: head, ...(body ? { body: JSON.stringify(body) } : {}) });
  const d = await r.json();
  return r.ok ? { data: d } : { error: d.message || '노션 요청 실패' };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
