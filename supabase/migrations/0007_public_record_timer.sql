-- A public record of every suggestion, a timer that notices new ones within about
-- two minutes, and voting windows that lengthen as more people play.

alter table public.settings
  add column plan_throttle_minutes int not null default 2 check (plan_throttle_minutes > 0),
  add column active_days int not null default 7 check (active_days > 0),
  -- Smallest group first. The first tier big enough for the active players is
  -- used, and bigger groups than any tier get cycle_hours.
  add column pace_tiers jsonb not null default
    '[{"players": 5, "minutes": 5}, {"players": 25, "minutes": 30}, {"players": 100, "minutes": 120}]';

-- Active means voted or suggested recently, so a quiet game speeds back up.
create or replace function public.active_players() returns bigint
language sql stable security definer set search_path = public as $$
  select count(distinct user_id) from (
    select user_id from votes
    where created_at > now() - make_interval(days => (select active_days from settings))
    union all
    select user_id from proposals
    where created_at > now() - make_interval(days => (select active_days from settings))
  ) recent;
$$;

create or replace function public.cycle_interval() returns interval
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select make_interval(mins => (tier->>'minutes')::int)
     from settings s, jsonb_array_elements(s.pace_tiers) tier
     where active_players() <= (tier->>'players')::bigint
     order by (tier->>'players')::bigint
     limit 1),
    (select make_interval(hours => cycle_hours) from settings)
  );
$$;

alter table public.settings
  drop column fast_cycle_minutes,
  drop column fast_until_releases,
  drop column medium_cycle_minutes,
  drop column medium_until_releases;

revoke execute on function public.active_players() from public, anon, authenticated;
grant execute on function public.active_players() to service_role;

-- Still never exposes the raw text, so unscreened or rejected content can't be
-- published. The title is the AI's summary, and credit only appears once it passes.
create or replace view public.public_proposals as
  select p.id, p.title, p.status,
    case when p.status = 'rejected' then p.reason end as reason,
    p.created_at,
    case when p.status in ('queued', 'on_ballot') then coalesce(pr.display_name, 'a player') end as credit
  from public.proposals p
  left join public.profiles pr on pr.user_id = p.user_id;

-- Runs on a timer. It only does database work, so a quiet game costs nothing.
create or replace function public.tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s settings;
  b ballots;
  win bigint;
  top_votes bigint;
  top_count int;
  no_change bigint;
  total bigint;
  to_build bigint[] := '{}';
  needs_plan boolean;
begin
  select * into s from settings;
  if s.paused then return jsonb_build_object('paused', true); end if;

  for b in select * from ballots where status = 'open' and closes_at <= now() for update loop
    select count(*) into total from votes where ballot_id = b.id;
    if total = 0 then
      -- Rule 2: no votes, so nothing moves. The same ballot simply stays open.
      update ballots set closes_at = now() + cycle_interval() where id = b.id;
      continue;
    end if;

    select id into no_change from options where ballot_id = b.id and is_no_change;
    select max(c), count(*) filter (where c = (select max(c2) from (
             select count(*) c2 from votes where ballot_id = b.id group by option_id) m))
      into top_votes, top_count
      from (select count(*) c from votes where ballot_id = b.id group by option_id) t;

    if top_count > 1 then
      win := no_change; -- Rule 3: ties go to "do not do this change".
    else
      select option_id into win from votes where ballot_id = b.id
        group by option_id order by count(*) desc limit 1;
    end if;

    if win = no_change then
      update ballots set status = 'closed', winner_option_id = win,
        outcome = 'The community chose not to make this change.' where id = b.id;
    else
      update ballots set status = 'building', winner_option_id = win where id = b.id;
    end if;
  end loop;

  -- Also retries a build whose start signal was lost.
  with due as (
    update ballots set build_dispatched_at = now()
    where status = 'building'
      and (build_dispatched_at is null or build_dispatched_at < now() - interval '2 hours')
    returning id
  ) select coalesce(array_agg(id), '{}') into to_build from due;

  needs_plan := not exists (
    select 1 from ballots where status in ('pending_review', 'open', 'building')
  ) or exists (select 1 from proposals where status = 'pending');

  if needs_plan and s.last_plan_dispatch_at is not null
     and s.last_plan_dispatch_at > now() - make_interval(mins => s.plan_throttle_minutes) then
    needs_plan := false;
  end if;
  if needs_plan then update settings set last_plan_dispatch_at = now(); end if;

  return jsonb_build_object('build', to_jsonb(to_build), 'plan', needs_plan);
end $$;

-- Only on the real project: the timer extension isn't in the test database.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('community-game-tick', '* * * * *', 'select public.scheduled_tick()');
  end if;
end $$;
