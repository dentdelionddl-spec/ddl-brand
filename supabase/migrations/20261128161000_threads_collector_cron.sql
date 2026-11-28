-- Schedules for the Threads collector. Apply after
-- 20261128160000_threads_collector.sql, after the edge function is
-- deployed. It creates its own vault secrets (cron bearer + function url).
--
-- Already applied on the live database. Do not re-run an older copy of this
-- file: that copy schedules threads-metrics every 30 minutes and reads the
-- service role key from Vault. Do not re-run this file on the live database.
--
-- Cadence, in Asia/Seoul, matching the old jobs.json intent:
--   (no 30-minute metrics job: same cadence as the old hermes server)
--   archive        07:30 every day   posts + metrics in one run (jobs.json threads-archive, hour 7 minute 30)
--   token_refresh  05:00 every day   (jobs.json token-watch, hour 5 minute 0)
-- pg_cron on this project runs in UTC. 07:30 KST is 22:30 UTC.
-- 05:00 KST is 20:00 UTC. There is no daylight-saving shift in Korea.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- The cron job authenticates with its own Vault secret, not the service role
-- key. The edge function checks it through threads_collector_auth().
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'THREADS_COLLECTOR_SECRET') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'THREADS_COLLECTOR_SECRET', 'threads-collector cron bearer');
  end if;
  if not exists (select 1 from vault.secrets where name = 'THREADS_COLLECTOR_URL') then
    perform vault.create_secret('https://adigccfynizkaijnqrhq.supabase.co/functions/v1/threads-collector', 'THREADS_COLLECTOR_URL', 'threads-collector function url');
  end if;
end;
$$;

create or replace function public.threads_collector_auth(p_secret text)
returns boolean
language sql
security definer
set search_path = public, vault
as $$
  select coalesce(
    (select decrypted_secret = p_secret from vault.decrypted_secrets where name = 'THREADS_COLLECTOR_SECRET' limit 1),
    false);
$$;

revoke all on function public.threads_collector_auth(text) from public, anon, authenticated;
grant execute on function public.threads_collector_auth(text) to service_role;

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
    from vault.decrypted_secrets where name = 'THREADS_COLLECTOR_SECRET';
  if target is null or secret is null then
    raise exception 'vault secrets THREADS_COLLECTOR_URL and THREADS_COLLECTOR_SECRET are required';
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
  perform cron.schedule('threads-archive', '30 22 * * *', $cron$select public.threads_collector_cron('archive')$cron$);
  perform cron.schedule('threads-token-refresh', '0 20 * * *', $cron$select public.threads_collector_cron('token_refresh')$cron$);
exception
  when undefined_table then
    raise exception 'pg_cron is not available. Enable it, then run this file again.';
end;
$$;
