// DDL 브랜드커머스 — 노션 프록시 (Vercel 서버리스 함수)
//
// 배포 후 주소: https://<프로젝트>.vercel.app/api/notion
//
// 필요한 환경변수 (Vercel > Settings > Environment Variables)
//   NOTION_TOKEN  = 노션 인테그레이션 토큰 (ntn_... 으로 시작)
//   ALLOW_ORIGIN  = (선택) https://dentdelionddl-spec.github.io — 비우면 모든 출처 허용
//
// 노션 쪽 준비: 사용할 DB 4개를 각각 열어 ⋯ → 연결 → 해당 인테그레이션 추가

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

export default async function handler(req, res) {
  const origin = process.env.ALLOW_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST만 받습니다' });
  if (!process.env.NOTION_TOKEN)
    return res.status(500).json({ message: 'NOTION_TOKEN 환경변수가 설정되지 않았습니다' });

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  if (!body) return res.status(400).json({ message: '요청 본문이 JSON이 아닙니다' });

  const head = {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    'Notion-Version': VERSION,
    'Content-Type': 'application/json',
  };

  try {
    const { action } = body;

    if (action === 'ping') return res.status(200).json({ ok: true });

    if (action === 'query') {
      const { database_id, filter, sorts, page_size } = body;
      if (!database_id) return res.status(400).json({ message: 'database_id가 없습니다' });
      let results = [];
      let cursor;
      do {
        const r = await fetch(`${NOTION}/databases/${database_id}/query`, {
          method: 'POST',
          headers: head,
          body: JSON.stringify({ filter, sorts, page_size: page_size || 100, start_cursor: cursor }),
        });
        const d = await r.json();
        if (!r.ok) return res.status(r.status).json({ message: d.message || '노션 조회 실패' });
        results = results.concat(d.results || []);
        cursor = d.has_more ? d.next_cursor : null;
      } while (cursor);
      return res.status(200).json({ results });
    }

    if (action === 'create') {
      const { database_id, properties } = body;
      if (!database_id) return res.status(400).json({ message: 'database_id가 없습니다' });
      return pass(res, `${NOTION}/pages`, {
        method: 'POST',
        headers: head,
        body: JSON.stringify({ parent: { database_id }, properties }),
      });
    }

    if (action === 'update') {
      const { page_id, properties } = body;
      if (!page_id) return res.status(400).json({ message: 'page_id가 없습니다' });
      return pass(res, `${NOTION}/pages/${page_id}`, {
        method: 'PATCH',
        headers: head,
        body: JSON.stringify({ properties }),
      });
    }

    if (action === 'delete') {
      const { page_id } = body;
      if (!page_id) return res.status(400).json({ message: 'page_id가 없습니다' });
      return pass(res, `${NOTION}/pages/${page_id}`, {
        method: 'PATCH',
        headers: head,
        body: JSON.stringify({ archived: true }),
      });
    }

    if (action === 'schema') {
      const { database_id } = body;
      return pass(res, `${NOTION}/databases/${database_id}`, { method: 'GET', headers: head });
    }

    return res.status(400).json({ message: `모르는 action: ${action}` });
  } catch (e) {
    return res.status(500).json({ message: String(e) });
  }
}

async function pass(res, url, init) {
  const r = await fetch(url, init);
  const d = await r.json();
  return res.status(r.status).json(d);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
