-- Shared play, for games that players vote to give it. Only numbers are kept: marks
-- left in the world and shared counters. There's no text, so players can't message
-- each other, and nothing handed out says who left a mark.

create table public.world_marks (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  x double precision not null,
  y double precision not null,
  z double precision not null,
  kind smallint not null check (kind between 0 and 31),
  created_at timestamptz not null default now()
);
create index world_marks_newest on public.world_marks (created_at desc);
create index world_marks_player on public.world_marks (user_id, created_at desc);

create table public.world_counters (
  slot smallint primary key check (slot between 0 and 15),
  value bigint not null default 0
);
insert into public.world_counters (slot) select generate_series(0, 15);

create table public.world_activity (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_mark_at timestamptz,
  last_add_at timestamptz
);

alter table public.world_marks enable row level security;
alter table public.world_counters enable row level security;
alter table public.world_activity enable row level security;
revoke all on public.world_marks, public.world_counters, public.world_activity from anon, authenticated;

create or replace function public.world_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'marks', coalesce((
      select jsonb_agg(jsonb_build_object('x', m.x, 'y', m.y, 'z', m.z, 'kind', m.kind, 'mine', m.user_id is not distinct from auth.uid()))
      from (
        select * from world_marks where created_at > now() - interval '7 days'
        order by created_at desc limit 200
      ) m), '[]'::jsonb),
    'counters', (select jsonb_agg(value order by slot) from world_counters));
$$;

create or replace function public.world_mark(p_x double precision, p_y double precision, p_z double precision, p_kind int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  if (select paused from settings) then return false; end if;
  -- NaN and infinity both count as beyond the limit here.
  if p_x is null or p_y is null or p_z is null or abs(p_x) > 100000 or abs(p_y) > 100000 or abs(p_z) > 100000 then
    raise exception 'that position is out of range';
  end if;
  if p_kind is null or p_kind not between 0 and 31 then raise exception 'that kind is out of range'; end if;

  insert into world_activity (user_id, last_mark_at) values (auth.uid(), now())
  on conflict (user_id) do update set last_mark_at = now()
    where world_activity.last_mark_at is null or world_activity.last_mark_at < now() - interval '10 seconds';
  if not found then return false; end if;

  insert into world_marks (user_id, x, y, z, kind) values (auth.uid(), p_x, p_y, p_z, p_kind);
  delete from world_marks where id in (
    select id from world_marks where user_id = auth.uid() order by created_at desc, id desc offset 5);
  return true;
end $$;

create or replace function public.world_add(p_slot int, p_amount int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  if (select paused from settings) then return false; end if;
  if p_slot is null or p_slot not between 0 and 15 then raise exception 'that counter is out of range'; end if;
  if p_amount is null or p_amount not between 1 and 10 then raise exception 'that amount is out of range'; end if;

  insert into world_activity (user_id, last_add_at) values (auth.uid(), now())
  on conflict (user_id) do update set last_add_at = now()
    where world_activity.last_add_at is null or world_activity.last_add_at < now() - interval '1 second';
  if not found then return false; end if;

  update world_counters set value = value + p_amount where slot = p_slot;
  return true;
end $$;

create or replace function public.prune_world() returns void
language sql security definer set search_path = public as $$
  delete from world_marks where created_at < now() - interval '7 days';
$$;

create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  return jsonb_build_object(
    'player_id', auth.uid(),
    'username', (select split_part(email, '@', 1) from auth.users where id = auth.uid()),
    'public_name', (select display_name from profiles where user_id = auth.uid()),
    'progress', player_stats(auth.uid()),
    'suggestions', coalesce((
      select jsonb_agg(jsonb_build_object('text', body, 'status', status, 'created_at', created_at) order by id)
      from proposals where user_id = auth.uid()), '[]'::jsonb),
    'votes', coalesce((
      select jsonb_agg(jsonb_build_object('question', b.question, 'choice', o.label, 'created_at', v.created_at) order by v.created_at)
      from votes v join ballots b on b.id = v.ballot_id join options o on o.id = v.option_id
      where v.user_id = auth.uid()), '[]'::jsonb),
    'upvotes', coalesce((
      select jsonb_agg(jsonb_build_object('idea', i.title, 'created_at', u.created_at) order by u.created_at)
      from upvotes u join ideas i on i.id = u.idea_id
      where u.user_id = auth.uid()), '[]'::jsonb),
    'downvotes', coalesce((
      select jsonb_agg(jsonb_build_object('idea', i.title, 'created_at', d.created_at) order by d.created_at)
      from downvotes d join ideas i on i.id = d.idea_id
      where d.user_id = auth.uid()), '[]'::jsonb),
    'game_save', (select data from game_saves where user_id = auth.uid()),
    'world_marks', coalesce((
      select jsonb_agg(jsonb_build_object('x', x, 'y', y, 'z', z, 'kind', kind, 'created_at', created_at) order by id)
      from world_marks where user_id = auth.uid()), '[]'::jsonb),
    'rounds_played', (select count(*) from participation where user_id = auth.uid()));
end $$;

revoke execute on function public.world_state() from public;
grant execute on function public.world_state() to anon, authenticated;
revoke execute on function public.world_mark(double precision, double precision, double precision, int) from public, anon;
grant execute on function public.world_mark(double precision, double precision, double precision, int) to authenticated;
revoke execute on function public.world_add(int, int) from public, anon;
grant execute on function public.world_add(int, int) to authenticated;
revoke execute on function public.prune_world() from public, anon, authenticated;

-- Live play: one private channel, for logged-in players only, which closes when the
-- site is paused. Open channels are separate from it, so they can't reach it.
create policy "players can hear the world" on realtime.messages for select to authenticated
  using ((select realtime.topic()) = 'world' and realtime.messages.extension in ('broadcast', 'presence')
    and not (select paused from public.settings));
create policy "players can move in the world" on realtime.messages for insert to authenticated
  with check ((select realtime.topic()) = 'world' and realtime.messages.extension in ('broadcast', 'presence')
    and not (select paused from public.settings));

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('community-game-prune-world', '41 * * * *', 'select public.prune_world()');
  end if;
end $$;
