/**
 * 예전 Cloudflare Worker 프록시.
 * 브랜드 데이터는 Vercel의 /api/notion 이 Supabase에 저장합니다.
 * 이 워커는 노션을 호출하지 않습니다.
 */
export default {
  async fetch() {
    return new Response(JSON.stringify({
      message: '이 주소는 더 이상 쓰지 않습니다. https://ddl-brand.vercel.app/api/notion 을 사용하세요.',
    }), {
      status: 410,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
