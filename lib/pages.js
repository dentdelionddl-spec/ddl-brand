// Notion-shaped pages on top of the migrated `notion.*` columns.
// The browser still sends the same property objects; columns stay filled so
// brand filters and realtime policies can see them.

import {
  asUuid, httpError, newId, rest, restAll, signObject, storagePathFromId, uploadObject, uploadObjectPath,
} from './supabase.js';

const normId = (id) => String(id || '').replace(/-/g, '').toLowerCase();

const title = (text) => {
  const content = text == null ? '' : String(text);
  return { title: [{ type: 'text', plain_text: content, text: { content } }] };
};
const rich = (text) => {
  const content = text == null ? '' : String(text);
  return { rich_text: [{ type: 'text', plain_text: content, text: { content } }] };
};
const sel = (name) => (name ? { select: { name: String(name) } } : { select: null });

function plain(prop) {
  if (!prop || typeof prop !== 'object') return undefined;
  const parts = prop.title || prop.rich_text;
  if (!Array.isArray(parts)) return undefined;
  return parts.map((t) => t.plain_text || t.text?.content || '').join('');
}

function readField(field, row) {
  if (field.type === 'date') {
    const start = row[field.prefix + '_start'];
    if (start == null || start === '') return undefined;
    const end = row[field.prefix + '_end'];
    const date = { start: String(start) };
    if (end) date.end = String(end);
    return { date };
  }
  if (field.type === 'files') return undefined;
  const value = row[field.col];
  if (value == null || value === '') {
    if (field.type === 'checkbox' && value === false) return { checkbox: false };
    return undefined;
  }
  if (field.type === 'title') return title(value);
  if (field.type === 'rich') return rich(value);
  if (field.type === 'select') return sel(value);
  if (field.type === 'status') return { status: { name: String(value) }, select: { name: String(value) } };
  if (field.type === 'number') return { number: Number(value) };
  if (field.type === 'checkbox') return { checkbox: !!value };
  if (field.type === 'url') return { url: String(value) };
  if (field.type === 'created_time') return { created_time: new Date(value).toISOString() };
  if (field.type === 'multi') {
    const list = Array.isArray(value) ? value : [];
    const names = list.map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
    return { multi_select: names.map((name) => ({ name })) };
  }
  return undefined;
}

function writeField(field, prop) {
  if (!prop || typeof prop !== 'object') return {};
  if (field.type === 'date') {
    const start = prop.date?.start || null;
    const end = prop.date?.end || null;
    const dt = !!(start && String(start).includes('T'));
    return {
      [field.prefix + '_start']: start,
      [field.prefix + '_end']: end,
      [field.prefix + '_is_datetime']: dt,
    };
  }
  if (field.type === 'title' || field.type === 'rich') {
    const text = plain(prop);
    return { [field.col]: text == null ? null : text };
  }
  if (field.type === 'select') return { [field.col]: prop.select?.name || null };
  if (field.type === 'status') return { [field.col]: prop.status?.name || prop.select?.name || null };
  if (field.type === 'number') return { [field.col]: prop.number == null || prop.number === '' ? null : Number(prop.number) };
  if (field.type === 'checkbox') return { [field.col]: !!prop.checkbox };
  if (field.type === 'url') return { [field.col]: prop.url || null };
  if (field.type === 'created_time') return { [field.col]: prop.created_time || null };
  if (field.type === 'multi') {
    const names = (prop.multi_select || []).map((x) => x && x.name).filter(Boolean);
    return { [field.col]: names };
  }
  return {};
}

function fileEntries(prop) {
  const files = prop && Array.isArray(prop.files) ? prop.files : [];
  const stored = [];
  for (const f of files) {
    const id = f?.file_upload?.id || f?.path || f?.external?.url || f?.file?.url || '';
    const path = storagePathFromId(id);
    if (path) stored.push({ path, name: f.name || path.split('/').pop() });
  }
  return { files, stored };
}

function filesProperty(row) {
  const raw = Array.isArray(row.files_storage) ? row.files_storage : [];
  const fromStorage = raw.map((item, i) => {
    if (typeof item === 'string') return { path: item, name: item.split('/').pop() };
    if (item && item.path) return { path: item.path, name: item.name || item.path.split('/').pop() || ('file-' + i) };
    return null;
  }).filter(Boolean);
  if (fromStorage.length) {
    return {
      files: fromStorage.map((f) => ({
        name: f.name,
        path: f.path,
        type: 'file',
        file: { url: '' },
      })),
    };
  }
  if (Array.isArray(row['첨부']) && row['첨부'].length) return { files: row['첨부'] };
  return undefined;
}

const F = (name, col, type, extra = {}) => ({ name, col, type, ...extra });
const D = (name, prefix) => ({ name, type: 'date', prefix });

export const TABLES = {
  contents: {
    id: '22c3381ad8e44f239be74fdd3243eba3',
    view: 'content_calendar',
    softDelete: true,
    fields: [
      F('제목', '제목', 'title'), F('브랜드', '브랜드', 'select'), F('유형', '유형', 'select'),
      D('날짜', '날짜'), F('완료', '완료', 'checkbox'), F('메모', '메모', 'rich'),
      F('로컬ID', '로컬id', 'rich'), F('담당자', '담당자', 'multi'), F('첨부', '첨부', 'files'),
    ],
  },
  tasks: {
    id: '1b390d2a35db48d796e26edaa0834a6a',
    view: 'weekly_plan',
    softDelete: true,
    syncBrand: true,
    fields: [
      F('Task', 'task', 'title'), F('Brand', 'brand', 'select'), F('브랜드', '브랜드', 'select'),
      F('Week', 'week', 'select'), F('영역', '영역', 'select'), F('세부', '세부', 'select'),
      D('Due', 'due'), F('Status', 'status', 'status'), F('담당자', '담당자', 'multi'),
      F('상세', '상세', 'rich'), F('순서', '순서', 'number'), F('로컬ID', '로컬id', 'rich'),
      F('메모', '메모', 'rich'), F('유형', '유형', 'select'), F('완료', '완료', 'checkbox'),
      D('날짜', '날짜'),
    ],
  },
  sales: {
    id: '5ca27a6560214303bc77b2da9e48ce02',
    view: 'sales',
    softDelete: true,
    fields: [
      F('항목', '항목', 'title'), F('브랜드', '브랜드', 'select'), F('월', '월', 'rich'),
      F('채널', '채널', 'select'), F('목표', '목표', 'number'), F('실적', '실적', 'number'),
      F('로컬ID', '로컬id', 'rich'),
    ],
  },
  daily: {
    id: 'c0a051c168524e599f630c949a78f985',
    view: 'daily_sales',
    softDelete: true,
    fields: [
      F('항목', '항목', 'title'), F('브랜드', '브랜드', 'select'), D('날짜', '날짜'),
      F('채널', '채널', 'select'), F('매출', '매출', 'number'), F('원가', '원가', 'number'),
      F('수수료', '수수료', 'number'), F('배송비', '배송비', 'number'), F('로컬ID', '로컬id', 'rich'),
    ],
  },
  plans: {
    id: '30a5544647d84123b4ad5e106c48c64e',
    view: 'content_plans',
    softDelete: true,
    fields: [
      F('주제', '주제', 'title'), F('브랜드', '브랜드', 'select'), F('월', '월', 'rich'),
      F('주차', '주차', 'select'), F('축', '축', 'rich'), F('레퍼런스', '레퍼런스', 'rich'),
      F('내용', '내용', 'rich'), F('형식', '형식', 'select'), F('소재', '소재', 'select'),
      F('훅유형', '훅유형', 'select'), F('소재 메모', '소재_메모', 'rich'), F('첨부', '첨부', 'files'),
      D('발행일', '발행일'), F('완료', '완료', 'checkbox'), F('목적', '목적', 'select'),
      F('로컬ID', '로컬id', 'rich'),
    ],
  },
  actions: {
    id: '21f72c37590f48dba49455f0c705b4ab',
    view: 'action_plan',
    softDelete: true,
    fields: [
      F('액션플랜', '액션플랜', 'title'), F('브랜드', '브랜드', 'select'), F('월', '월', 'rich'),
      F('목표치', '목표치', 'number'), F('현재치', '현재치', 'number'), F('단위', '단위', 'rich'),
      F('메모', '메모', 'rich'), F('연결업무', '연결업무', 'rich'), F('로컬ID', '로컬id', 'rich'),
    ],
  },
  stats: {
    id: '691bda8c1aec4253964f2adda0e18c05',
    view: 'threads_performance',
    softDelete: true,
    fields: [
      F('제목', '제목', 'title'), D('발행일', '발행일'), F('브랜드', '브랜드', 'select'),
      F('채널', '채널', 'select'), F('URL', 'userdefined_url', 'url'),
      F('조회수', '조회수', 'number'), F('좋아요', '좋아요', 'number'), F('댓글', '댓글', 'number'),
      F('저장', '저장', 'number'), F('팔로우 전환', '팔로우_전환', 'number'),
      F('프로필 유입', '프로필_유입', 'number'), F('목적태그', '목적태그', 'select'),
      F('훅유형', '훅유형', 'select'), F('소재출처', '소재출처', 'select'), F('화자위치', '화자위치', 'select'),
      F('글자수', '글자수', 'number'), F('이미지 유무', '이미지_유무', 'checkbox'),
      F('발행시간대', '발행시간대', 'select'), F('본문', '본문', 'rich'), F('로컬ID', '로컬id', 'rich'),
    ],
  },
  refs: {
    id: 'ae4c78c3a8324090b2617774d9ae3f01',
    view: 'brand_references',
    softDelete: true,
    fields: [
      F('제목', '제목', 'title'), F('브랜드', '브랜드', 'select'), F('분류', '분류', 'select'),
      F('링크', '링크', 'url'), F('메모', '메모', 'rich'), F('로컬ID', '로컬id', 'rich'),
    ],
  },
  costs: {
    id: 'e33ee267da7d43fd86f72c28fa888114',
    view: 'costs',
    softDelete: true,
    fields: [
      F('항목', '항목', 'title'), F('브랜드', '브랜드', 'select'), F('월', '월', 'rich'),
      F('구분', '구분', 'select'), F('금액', '금액', 'number'), F('로컬ID', '로컬id', 'rich'),
    ],
  },
  products: {
    id: 'ddd18f71b6c9475abc59f74881cff410',
    view: 'products',
    softDelete: true,
    fields: [
      F('제품명', '제품명', 'title'), F('브랜드', '브랜드', 'select'), F('상태', '상태', 'select'),
      F('SKU', 'sku', 'rich'), F('판매가', '판매가', 'number'), F('재고', '재고', 'number'),
      D('입고예정', '입고예정'), F('종류', '종류', 'select'), F('소재', '소재', 'select'),
      F('시즌', '시즌', 'select'), F('입고가', '입고가', 'number'), D('출시일', '출시일'),
      F('출시연도', '출시연도', 'select'), F('출시분기', '출시분기', 'select'),
      F('컬러', '컬러', 'select'), F('사이즈', '사이즈', 'rich'), F('도금', '도금', 'rich'),
      F('이미지', '이미지', 'url'), D('최종수정일', '최종수정일'), F('로컬ID', '로컬id', 'rich'),
    ],
  },
  config: {
    id: '46b8ab2d1ddc47f7b5f8c0bfa4748ab9',
    view: 'app_settings',
    softDelete: true,
    fields: [
      F('항목', '항목', 'title'), F('값', '값', 'rich'), F('수정시각', '수정시각', 'rich'),
    ],
  },
  inquiries: {
    id: 'b400cf41ae804765b1b15e3a4b004ba1',
    view: 'oem_inquiries_yj',
    softDelete: true,
    fields: [
      F('브랜드·회사명', '브랜드_회사명', 'title'),
      F('접수일시', '접수일시', 'created_time'),
      F('유입 경로', '유입_경로', 'select'),
      F('진행 상태', '진행_상태', 'select'),
    ],
  },
  traffic: {
    id: '22b96ecfb203408295a3f8755c6935b6',
    view: 'visit_stats_yj',
    softDelete: true,
    fields: [
      F('날짜', '날짜', 'title'), D('일자', '일자'),
      F('방문', '방문', 'number'), F('순방문', '순방문', 'number'),
      F('스레드', '스레드', 'number'), F('인스타', '인스타', 'number'),
      F('직접', '직접', 'number'), F('기타', '기타', 'number'),
    ],
  },
};

const BY_ID = new Map(Object.entries(TABLES).map(([key, spec]) => [normId(spec.id), key]));

export function tableKey(databaseId) {
  return BY_ID.get(normId(databaseId)) || null;
}

export function rowToPage(spec, row) {
  const props = (row.properties && typeof row.properties === 'object' && !Array.isArray(row.properties))
    ? { ...row.properties } : {};
  for (const field of spec.fields) {
    if (field.type === 'files') continue;
    const built = readField(field, row);
    if (built !== undefined) props[field.name] = built;
  }
  const files = filesProperty(row);
  if (files) props['첨부'] = files;
  if (spec.syncBrand) {
    const name = props.Brand?.select?.name || props['브랜드']?.select?.name;
    if (name) {
      props.Brand = sel(name);
      props['브랜드'] = sel(name);
    }
  }
  if (spec.view === 'visit_stats_yj' && !props['일자']?.date?.start && props['날짜']?.title) {
    const day = plain(props['날짜']);
    if (day) props['일자'] = { date: { start: day } };
  }
  return {
    id: row.notion_page_id,
    archived: !!row.deleted_at,
    editedAt: row.last_edited_time || null,
    parent: { database_id: spec.id },
    properties: props,
  };
}

export function columnsFromProperties(spec, properties, existing) {
  const props = properties || {};
  const cols = {};
  for (const field of spec.fields) {
    if (field.type === 'files') {
      if (!('첨부' in props) && field.name !== '첨부') continue;
      if (!(field.name in props)) continue;
      const { files, stored } = fileEntries(props[field.name]);
      cols[field.col] = files;
      cols.files_storage = stored;
      continue;
    }
    if (!(field.name in props)) continue;
    Object.assign(cols, writeField(field, props[field.name]));
  }
  if (spec.syncBrand && ('Brand' in props || '브랜드' in props)) {
    const name = cols.brand || cols['브랜드'] || null;
    cols.brand = name;
    cols['브랜드'] = name;
  }
  const prev = (existing && existing.properties && typeof existing.properties === 'object') ? existing.properties : {};
  cols.properties = { ...prev, ...props };
  return cols;
}

function sinceFilter(spec, since) {
  if (!/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(since)) throw httpError(400, 'since 형식이 맞지 않습니다');
  const quoted = `"${since}"`;
  if (spec.softDelete) return { or: `(last_edited_time.gt.${quoted},deleted_at.gt.${quoted})` };
  return { last_edited_time: `gt.${quoted}` };
}

async function signPages(pages) {
  const jobs = [];
  for (const page of pages) {
    const files = page.properties?.['첨부']?.files;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      const path = file.path || storagePathFromId(file.file_upload?.id || '');
      if (!path) continue;
      jobs.push(signObject(path).then((url) => {
        if (!url) return;
        file.file = { url };
        file.external = { url };
      }));
    }
  }
  await Promise.all(jobs);
}

export async function listRows(key, opts = {}) {
  const spec = TABLES[key];
  if (!spec) throw httpError(404, '없는 DB입니다');
  const query = {};
  if (opts.since) Object.assign(query, sinceFilter(spec, opts.since));
  else if (spec.softDelete) query.deleted_at = 'is.null';
  const rows = await restAll(spec.view, query);
  const pages = rows.map((row) => rowToPage(spec, row));
  await signPages(pages.filter((p) => !p.archived));
  return pages;
}

export async function createRow(key, properties) {
  const spec = TABLES[key];
  if (!spec) throw httpError(404, '없는 DB입니다');
  const id = newId();
  const now = new Date().toISOString();
  const cols = columnsFromProperties(spec, properties, null);
  cols.notion_page_id = id;
  cols.created_time = now;
  cols.last_edited_time = now;
  const rows = await rest(spec.view, { method: 'POST', body: cols, prefer: 'return=representation' });
  const row = Array.isArray(rows) ? rows[0] : null;
  const page = rowToPage(spec, row || { ...cols, properties });
  await signPages([page]);
  return page;
}

async function loadOne(spec, id) {
  const rows = await rest(spec.view, { query: { notion_page_id: 'eq.' + id, select: '*', limit: 1 } });
  return Array.isArray(rows) ? rows[0] : null;
}

export async function findRow(pageId, keys) {
  const id = asUuid(pageId);
  if (!id) return null;
  const hits = await Promise.all(keys.map(async (key) => {
    const spec = TABLES[key];
    if (!spec) return null;
    const row = await loadOne(spec, id);
    return row ? { key, row, id } : null;
  }));
  return hits.find(Boolean) || null;
}

export async function updateRow(key, pageId, properties) {
  const spec = TABLES[key];
  const id = asUuid(pageId);
  if (!spec || !id) throw httpError(400, 'page_id가 없습니다');
  const existing = await loadOne(spec, id);
  if (!existing || existing.deleted_at) throw httpError(404, '페이지를 찾지 못했습니다');
  const cols = columnsFromProperties(spec, properties, existing);
  cols.last_edited_time = new Date().toISOString();
  const rows = await rest(spec.view, {
    method: 'PATCH',
    query: { notion_page_id: 'eq.' + id },
    body: cols,
    prefer: 'return=representation',
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  const page = rowToPage(spec, row || { ...existing, ...cols });
  await signPages([page]);
  return page;
}

export async function archiveRow(key, pageId) {
  const spec = TABLES[key];
  const id = asUuid(pageId);
  if (!spec || !id) throw httpError(400, 'page_id가 없습니다');
  const existing = await loadOne(spec, id);
  if (!existing || existing.deleted_at) throw httpError(404, '페이지를 찾지 못했습니다');
  const now = new Date().toISOString();
  await rest(spec.view, {
    method: 'PATCH',
    query: { notion_page_id: 'eq.' + id },
    body: { deleted_at: now, last_edited_time: now },
    prefer: 'return=minimal',
  });
  return { ok: true, id };
}

export async function uploadFile({ filename, contentType, bytes }) {
  const rel = uploadObjectPath(filename);
  await uploadObject('notion-files/' + rel, bytes, contentType);
  return { id: rel, filename: rel.split('/').pop(), status: 'uploaded' };
}
