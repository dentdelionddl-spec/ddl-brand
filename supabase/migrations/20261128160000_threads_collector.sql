-- Threads collector tables, read views, and write functions.
-- Apply in the Supabase SQL editor (project ddl) before deploying the
-- edge function. Safe to re-run. Does not delete rows.
-- Does not schedule anything and does not set secrets. See
-- 20261128161000_threads_collector_cron.sql and supabase/README.md.
--
-- hermes.threads_posts and hermes.threads_post_metrics already exist.
-- This file only adds the log, the token store, account snapshots,
-- and the functions the edge function calls with the service role.

create table if not exists hermes.threads_collector_runs (
  id bigint generated always as identity primary key,
  job text not null,
  status text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  posts integer,
  brands integer,
  error text,
  detail jsonb
);

create table if not exists hermes.threads_token_store (
  brand text primary key,
  token_env text not null,
  access_token text not null,
  token_fingerprint text not null,
  refreshed_at timestamptz,
  expires_at timestamptz,
  first_seen_at timestamptz,
  refresh_failed_at timestamptz,
  refresh_error text
);

create table if not exists hermes.threads_account_snapshots (
  id bigint generated always as identity primary key,
  brand text not null,
  collected_at timestamptz not null,
  followers_count bigint,
  profile_views bigint,
  unique (brand, collected_at)
);

comment on table hermes.threads_collector_runs is
  'Threads collector success and failure log. The analysis screen reads the latest success.';
comment on table hermes.threads_token_store is
  'Refreshed Threads tokens. Service role only. Never grant this to anon.';
comment on table hermes.threads_account_snapshots is
  'Account-level follower counts used as a baseline. Not a per-post metric.';

alter table hermes.threads_collector_runs enable row level security;
alter table hermes.threads_token_store enable row level security;
alter table hermes.threads_account_snapshots enable row level security;

grant usage on schema hermes to service_role;
grant select on table hermes.threads_posts to service_role;
grant select, insert on table hermes.threads_post_metrics to service_role;
grant usage, select on sequence hermes.threads_post_metrics_id_seq to service_role;
grant select, insert on table hermes.threads_collector_runs to service_role;
grant select, insert, update on table hermes.threads_token_store to service_role;
grant select, insert on table hermes.threads_account_snapshots to service_role;
grant usage, select on sequence hermes.threads_collector_runs_id_seq to service_role;
grant usage, select on sequence hermes.threads_account_snapshots_id_seq to service_role;

create or replace view public.threads_collector_runs
  with (security_invoker = true) as
  select id, job, status, started_at, finished_at, posts, brands, error
  from hermes.threads_collector_runs;

create or replace view public.threads_post_metrics_read
  with (security_invoker = true) as
  select brand, post_id, collected_at, views, likes, replies, reposts, quotes, shares, extra
  from hermes.threads_post_metrics;

create or replace view public.threads_account_snapshots
  with (security_invoker = true) as
  select brand, collected_at, followers_count, profile_views
  from hermes.threads_account_snapshots;

create or replace view public.threads_token_store
  with (security_invoker = true) as
  select brand, token_env, access_token, token_fingerprint, refreshed_at, expires_at,
         first_seen_at, refresh_failed_at, refresh_error
  from hermes.threads_token_store;

comment on view public.threads_collector_runs is
  'ddl-brand service_role read of collector runs. The analysis API uses this for 마지막 수집.';
comment on view public.threads_token_store is
  'Service role only. Holds refreshed Threads access tokens.';

revoke all on table public.threads_collector_runs from public, anon, authenticated;
revoke all on table public.threads_post_metrics_read from public, anon, authenticated;
revoke all on table public.threads_account_snapshots from public, anon, authenticated;
revoke all on table public.threads_token_store from public, anon, authenticated;

grant select on table public.threads_collector_runs to service_role;
grant select on table public.threads_post_metrics_read to service_role;
grant select on table public.threads_account_snapshots to service_role;
grant select, insert, update on table public.threads_token_store to service_role;

create or replace function public.threads_collector_apply(payload jsonb)
returns void
language plpgsql
security definer
set search_path = hermes, notion, public
as $$
declare
  item jsonb;
  local_id text;
  updated_count integer;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'payload must be an object';
  end if;

  for item in select * from jsonb_array_elements(coalesce(payload->'posts', '[]'::jsonb))
  loop
    insert into hermes.threads_posts (
      brand, post_id, text, posted_at, permalink, media_type, is_quote_post,
      first_collected_at, last_collected_at
    ) values (
      item->>'brand',
      item->>'post_id',
      item->>'text',
      nullif(item->>'posted_at', '')::timestamptz,
      nullif(item->>'permalink', ''),
      nullif(item->>'media_type', ''),
      coalesce((item->>'is_quote_post')::boolean, false),
      nullif(item->>'first_collected_at', '')::timestamptz,
      nullif(item->>'last_collected_at', '')::timestamptz
    )
    on conflict (brand, post_id) do update set
      text = excluded.text,
      posted_at = coalesce(excluded.posted_at, hermes.threads_posts.posted_at),
      permalink = coalesce(excluded.permalink, hermes.threads_posts.permalink),
      media_type = coalesce(excluded.media_type, hermes.threads_posts.media_type),
      is_quote_post = excluded.is_quote_post,
      last_collected_at = excluded.last_collected_at,
      first_collected_at = coalesce(hermes.threads_posts.first_collected_at, excluded.first_collected_at);
  end loop;

  for item in select * from jsonb_array_elements(coalesce(payload->'metrics', '[]'::jsonb))
  loop
    insert into hermes.threads_post_metrics (
      brand, post_id, collected_at, source_file, views, likes, replies, reposts, quotes, shares, extra
    ) values (
      item->>'brand',
      item->>'post_id',
      nullif(item->>'collected_at', '')::timestamptz,
      coalesce(item->>'source_file', 'edge/threads-collector'),
      nullif(item->>'views', '')::bigint,
      nullif(item->>'likes', '')::bigint,
      nullif(item->>'replies', '')::bigint,
      nullif(item->>'reposts', '')::bigint,
      nullif(item->>'quotes', '')::bigint,
      nullif(item->>'shares', '')::bigint,
      coalesce(item->'extra', '{}'::jsonb)
    );
  end loop;

  if payload ? 'account' and jsonb_typeof(payload->'account') = 'object' then
    insert into hermes.threads_account_snapshots (brand, collected_at, followers_count, profile_views)
    values (
      payload->'account'->>'brand',
      nullif(payload->'account'->>'collected_at', '')::timestamptz,
      nullif(payload->'account'->>'followers_count', '')::bigint,
      nullif(payload->'account'->>'profile_views', '')::bigint
    )
    on conflict (brand, collected_at) do nothing;
  end if;

  for item in select * from jsonb_array_elements(coalesce(payload->'performance', '[]'::jsonb))
  loop
    local_id := item->>'로컬id';
    if local_id is null or local_id = '' then
      continue;
    end if;
    update notion.threads_performance set
      "제목" = item->>'제목',
      "본문" = item->>'본문',
      "브랜드" = item->>'브랜드',
      "채널" = coalesce(item->>'채널', '스레드'),
      userdefined_url = nullif(item->>'userdefined_url', ''),
      "발행일_start" = nullif(item->>'발행일_start', ''),
      "발행일_is_datetime" = coalesce((item->>'발행일_is_datetime')::boolean, false),
      "조회수" = nullif(item->>'조회수', '')::numeric,
      "좋아요" = nullif(item->>'좋아요', '')::numeric,
      "댓글" = nullif(item->>'댓글', '')::numeric,
      "이미지_유무" = coalesce((item->>'이미지_유무')::boolean, false),
      "누적_성과_스냅샷" = item->>'누적_성과_스냅샷',
      "인사이트_관측시각_start" = nullif(item->>'인사이트_관측시각_start', ''),
      "인사이트_관측시각_is_datetime" = coalesce((item->>'인사이트_관측시각_is_datetime')::boolean, false),
      "관측_경과시간" = nullif(item->>'관측_경과시간', '')::numeric,
      "프로필_유입" = coalesce(nullif(item->>'프로필_유입', '')::numeric, "프로필_유입"),
      "발행시_팔로워" = coalesce(nullif(item->>'발행시_팔로워', '')::numeric, "발행시_팔로워"),
      "관측시_팔로워" = coalesce(nullif(item->>'관측시_팔로워', '')::numeric, "관측시_팔로워"),
      "팔로우_전환" = coalesce(nullif(item->>'팔로우_전환', '')::numeric, "팔로우_전환"),
      "동시_게시물_수" = coalesce(nullif(item->>'동시_게시물_수', '')::numeric, "동시_게시물_수"),
      "인사이트_귀속" = coalesce(nullif(item->>'인사이트_귀속', ''), "인사이트_귀속"),
      last_edited_time = now()
    where "로컬id" = local_id and deleted_at is null;
    get diagnostics updated_count = row_count;
    if updated_count = 0 then
      insert into notion.threads_performance (
        "제목", "본문", "브랜드", "채널", "로컬id", userdefined_url,
        "발행일_start", "발행일_is_datetime", "조회수", "좋아요", "댓글",
        "이미지_유무", "누적_성과_스냅샷", "인사이트_관측시각_start",
        "인사이트_관측시각_is_datetime", "관측_경과시간", "프로필_유입",
        "발행시_팔로워", "관측시_팔로워", "팔로우_전환", "동시_게시물_수", "인사이트_귀속"
      ) values (
        item->>'제목',
        item->>'본문',
        item->>'브랜드',
        coalesce(item->>'채널', '스레드'),
        local_id,
        nullif(item->>'userdefined_url', ''),
        nullif(item->>'발행일_start', ''),
        coalesce((item->>'발행일_is_datetime')::boolean, false),
        nullif(item->>'조회수', '')::numeric,
        nullif(item->>'좋아요', '')::numeric,
        nullif(item->>'댓글', '')::numeric,
        coalesce((item->>'이미지_유무')::boolean, false),
        item->>'누적_성과_스냅샷',
        nullif(item->>'인사이트_관측시각_start', ''),
        coalesce((item->>'인사이트_관측시각_is_datetime')::boolean, false),
        nullif(item->>'관측_경과시간', '')::numeric,
        nullif(item->>'프로필_유입', '')::numeric,
        nullif(item->>'발행시_팔로워', '')::numeric,
        nullif(item->>'관측시_팔로워', '')::numeric,
        nullif(item->>'팔로우_전환', '')::numeric,
        nullif(item->>'동시_게시물_수', '')::numeric,
        nullif(item->>'인사이트_귀속', '')
      );
    end if;
  end loop;
end;
$$;

create or replace function public.threads_collector_log(
  p_job text,
  p_status text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_posts integer,
  p_brands integer,
  p_error text,
  p_detail jsonb
) returns void
language plpgsql
security definer
set search_path = hermes, public
as $$
begin
  insert into hermes.threads_collector_runs (job, status, started_at, finished_at, posts, brands, error, detail)
  values (p_job, p_status, p_started_at, p_finished_at, p_posts, p_brands, nullif(p_error, ''), coalesce(p_detail, '{}'::jsonb));
end;
$$;

create or replace function public.threads_collector_save_token(
  p_brand text,
  p_token_env text,
  p_access_token text,
  p_fingerprint text,
  p_expires_at timestamptz,
  p_refreshed_at timestamptz,
  p_first_seen_at timestamptz,
  p_refresh_failed_at timestamptz,
  p_refresh_error text
) returns void
language plpgsql
security definer
set search_path = hermes, public
as $$
begin
  insert into hermes.threads_token_store (
    brand, token_env, access_token, token_fingerprint, expires_at, refreshed_at,
    first_seen_at, refresh_failed_at, refresh_error
  ) values (
    p_brand, p_token_env, p_access_token, p_fingerprint, p_expires_at, p_refreshed_at,
    p_first_seen_at, p_refresh_failed_at, nullif(p_refresh_error, '')
  )
  on conflict (brand) do update set
    token_env = excluded.token_env,
    access_token = excluded.access_token,
    token_fingerprint = excluded.token_fingerprint,
    expires_at = excluded.expires_at,
    refreshed_at = excluded.refreshed_at,
    first_seen_at = coalesce(hermes.threads_token_store.first_seen_at, excluded.first_seen_at),
    refresh_failed_at = excluded.refresh_failed_at,
    refresh_error = excluded.refresh_error;
end;
$$;

revoke all on function public.threads_collector_apply(jsonb) from public, anon, authenticated;
revoke all on function public.threads_collector_log(text, text, timestamptz, timestamptz, integer, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.threads_collector_save_token(text, text, text, text, timestamptz, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated;

grant execute on function public.threads_collector_apply(jsonb) to service_role;
grant execute on function public.threads_collector_log(text, text, timestamptz, timestamptz, integer, integer, text, jsonb) to service_role;
grant execute on function public.threads_collector_save_token(text, text, text, text, timestamptz, timestamptz, timestamptz, timestamptz, text) to service_role;

notify pgrst, 'reload schema';
