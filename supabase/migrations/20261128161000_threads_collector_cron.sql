-- Schedules for the Threads collector. Apply after
-- 20261128160000_threads_collector.sql, after the edge function is
-- deployed, and after the two vault secrets in supabase/README.md exist.
--
-- Cadence, in Asia/Seoul, matching the old jobs.json intent:
--   metrics        every 30 minutes
--   archive        07:30 every day   (jobs.json threads-archive, hour 7 minute 30)
--   token_refresh  05:00 every day   (jobs.json token-watch, hour 5 minute 0)
-- pg_cron on this project runs in UTC. 07:30 KST is 22:30 UTC.
-- 05:00 KST is 20:00 UTC. There is no daylight-saving shift in Korea.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.threads_collector_cron(p_job text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  target text;
  secret text;
  request_id bigint;
begin
  if p_job not in ('metrics', 'archive', 'token_refresh') then
    raise exception 'unknown collector job';
  end if;
  select decrypted_secret into target
    from vault.decrypted_secrets where name = 'THREADS_COLLECTOR_URL';
  select decrypted_secret into secret
    from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY';
  if target is null or secret is null then
    raise exception 'vault secrets THREADS_COLLECTOR_URL and SUPABASE_SERVICE_ROLE_KEY are required';
  end if;
  select net.http_post(
    url := target,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || secret
    ),
    body := jsonb_build_object('job', p_job),
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.threads_collector_cron(text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'threads-metrics') then
    perform cron.unschedule('threads-metrics');
  end if;
  if exists (select 1 from cron.job where jobname = 'threads-archive') then
    perform cron.unschedule('threads-archive');
  end if;
  if exists (select 1 from cron.job where jobname = 'threads-token-refresh') then
    perform cron.unschedule('threads-token-refresh');
  end if;
  perform cron.schedule('threads-metrics', '*/30 * * * *', $cron$select public.threads_collector_cron('metrics')$cron$);
  perform cron.schedule('threads-archive', '30 22 * * *', $cron$select public.threads_collector_cron('archive')$cron$);
  perform cron.schedule('threads-token-refresh', '0 20 * * *', $cron$select public.threads_collector_cron('token_refresh')$cron$);
exception
  when undefined_table then
    raise exception 'pg_cron is not available. Enable it, then run this file again.';
end;
$$;
