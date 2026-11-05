-- Runs the timer on Supabase and starts GitHub workflows only when work exists.
-- Needs two Vault secrets: github_repo ("owner/name") and github_dispatch_token.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.scheduled_tick() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  result jsonb;
  repo text;
  token text;
  id jsonb;
begin
  result := tick();
  if result ? 'paused' then return; end if;

  select decrypted_secret into repo from vault.decrypted_secrets where name = 'github_repo';
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_dispatch_token';

  if (result->>'plan')::boolean then
    perform net.http_post(
      url := 'https://api.github.com/repos/' || repo || '/dispatches',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Accept', 'application/vnd.github+json',
        'User-Agent', 'community-game'),
      body := jsonb_build_object('event_type', 'plan'));
  end if;

  for id in select * from jsonb_array_elements(result->'build') loop
    perform net.http_post(
      url := 'https://api.github.com/repos/' || repo || '/dispatches',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Accept', 'application/vnd.github+json',
        'User-Agent', 'community-game'),
      body := jsonb_build_object(
        'event_type', 'build',
        'client_payload', jsonb_build_object('ballot_id', id)));
  end loop;
end $$;

revoke execute on function public.scheduled_tick() from public, anon, authenticated;

select cron.schedule('community-game-tick', '*/5 * * * *', 'select public.scheduled_tick()');
