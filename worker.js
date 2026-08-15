/**
 * DDL 브랜드커머스 — 노션 프록시 (Cloudflare Worker)
 *
 * 배포 전 설정
 *   1) Workers & Pages → Create Worker → 이 파일 내용 붙여넣기 → Deploy
 *   2) Settings → Variables → Secret 추가:  NOTION_TOKEN = ntn_xxxxx (노션 인테그레이션 토큰)
 *   3) (선택) ALLOW_ORIGIN = https://<깃허브아이디>.github.io   ← 비우면 모든 출처 허용
 *   4) 배포된 주소를 관리페이지 설정 화면의 Worker URL 칸에 붙여넣기
 *
 * 노션 쪽 준비
 *   - 인테그레이션 만들기: notion.so/my-integrations
 *   - 사용할 DB 4개를 각각 열어 ⋯ → 연결 → 해당 인테그레이션 추가
 */

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST')
      return json({ message: 'POST만 받습니다' }, 405, cors);
    if (!env.NOTION_TOKEN)
      return json({ message: 'NOTION_TOKEN 환경변수가 설정되지 않았습니다' }, 500, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ message: '요청 본문이 JSON이 아닙니다' }, 400, cors); }

    const { action } = body;
    const head = {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': VERSION,
      'Content-Type': 'application/json',
    };

    try {
      if (action === 'ping') return json({ ok: true }, 200, cors);

      if (action === 'query') {
        const { database_id, filter, sorts, page_size } = body;
        if (!database_id) return json({ message: 'database_id가 없습니다' }, 400, cors);
        // 100건 넘어가면 자동으로 이어받습니다
        let results = [], cursor;
        do {
          const r = await fetch(`${NOTION}/databases/${database_id}/query`, {
            method: 'POST', headers: head,
            body: JSON.stringify({ filter, sorts, page_size: page_size || 100, start_cursor: cursor }),
          });
          const d = await r.json();
          if (!r.ok) return json({ message: d.message || '노션 조회 실패' }, r.status, cors);
          results = results.concat(d.results || []);
          cursor = d.has_more ? d.next_cursor : null;
        } while (cursor);
        return json({ results }, 200, cors);
      }

      if (action === 'create') {
        const { database_id, properties } = body;
        if (!database_id) return json({ message: 'database_id가 없습니다' }, 400, cors);
        return await pass(`${NOTION}/pages`, {
          method: 'POST', headers: head,
          body: JSON.stringify({ parent: { database_id }, properties }),
        }, cors);
      }

      if (action === 'update') {
        const { page_id, properties } = body;
        if (!page_id) return json({ message: 'page_id가 없습니다' }, 400, cors);
        return await pass(`${NOTION}/pages/${page_id}`, {
          method: 'PATCH', headers: head, body: JSON.stringify({ properties }),
        }, cors);
      }

      if (action === 'delete') {
        const { page_id } = body;
        if (!page_id) return json({ message: 'page_id가 없습니다' }, 400, cors);
        return await pass(`${NOTION}/pages/${page_id}`, {
          method: 'PATCH', headers: head, body: JSON.stringify({ archived: true }),
        }, cors);
      }

      if (action === 'schema') {
        const { database_id } = body;
        return await pass(`${NOTION}/databases/${database_id}`, { method: 'GET', headers: head }, cors);
      }

      return json({ message: `모르는 action: ${action}` }, 400, cors);
    } catch (e) {
      return json({ message: String(e) }, 500, cors);
    }
  },
};

async function pass(url, init, cors) {
  const r = await fetch(url, init);
  const d = await r.json();
  return json(d, r.status, cors);
}
function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}
