// DDL 브랜드 관리 — 브랜드별 공개 일정 (Vercel 서버리스 함수)
//
// GET /api/schedule?brand=vivicate
// 외부 사이트(ek-oem 등)에 보여줄 일정만 내보냅니다. 메모·첨부·담당자는 내보내지 않습니다.
// 필요한 환경변수: NOTION_TOKEN

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const CONTENTS_DB = '22c3381ad8e44f239be74fdd3243eba3';

/* 공개를 허용한 브랜드만 (주소 값 → 노션 '브랜드' 선택값) */
const PUBLIC_BRANDS = {
  vivicate: ['VIVICATE'],
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ message: 'GET만 받습니다' });

  const brand = String(req.query.brand || '').toLowerCase();
  const names = PUBLIC_BRANDS[brand];
  if (!names) return res.status(404).json({ message: '공개되지 않은 브랜드입니다' });
  if (!process.env.NOTION_TOKEN)
    return res.status(500).json({ message: 'NOTION_TOKEN 환경변수가 설정되지 않았습니다' });

  try {
    let pages = [];
    let cursor;
    do {
      const r = await fetch(NOTION+'/databases/'+CONTENTS_DB+'/query', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer '+process.env.NOTION_TOKEN,
          'Notion-Version': VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filter: { or: names.map(n => ({ property: '브랜드', select: { equals: n } })) },
          sorts: [{ property: '날짜', direction: 'ascending' }],
          page_size: 100,
          start_cursor: cursor,
        }),
      });
      const d = await r.json();
      if (!r.ok) return res.status(502).json({ message: d.message || '노션 조회 실패' });
      pages = pages.concat(d.results || []);
      cursor = d.has_more ? d.next_cursor : null;
    } while (cursor);

    const today = kstToday();
    const items = pages
      .filter(pg => pg.properties?.['날짜']?.date?.start)
      .map(pg => {
        const P = pg.properties;
        const date = P['날짜'].date.start.slice(0, 10);
        const end = P['날짜'].date.end ? P['날짜'].date.end.slice(0, 10) : null;
        const done = !!P['완료']?.checkbox;
        const status = done ? '완료' : (date <= today && (end || date) >= today ? '진행중' : '예정');
        return {
          id: pg.id.replace(/-/g, '').slice(-8),
          date,
          endDate: end && end !== date ? end : null,
          title: (P['제목']?.title || []).map(t => t.plain_text).join(''),
          category: P['유형']?.select?.name || '',
          status,
        };
      });

    /* 운영페이지에서 고친 내용이 바로 보이도록 캐시하지 않음 */
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ brand, updatedAt: new Date().toISOString(), items });
  } catch (e) {
    return res.status(500).json({ message: String(e) });
  }
}

function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
