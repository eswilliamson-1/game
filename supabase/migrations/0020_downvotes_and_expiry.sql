-- Players can downvote ideas off the board, and player suggestions that nobody
-- upvotes for a while leave by themselves. Both end as a public rejection, so the
-- suggestion record says why and the privacy cleanup still clears the text.

alter table public.settings
  add column idea_expiry_days int not null default 3 check (idea_expiry_days > 0);

create table public.downvotes (
  idea_id bigint not null references public.ideas (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);

alter table public.downvotes enable row level security;
revoke all on public.downvotes from anon, authenticated;
grant select, insert, update on public.downvotes to service_role;

create or replace function public.remove_idea(p_idea bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  suggestion bigint;
begin
  update ideas set status = 'rejected' where id = p_idea and status = 'open'
    returning proposal_id into suggestion;
  if suggestion is not null then
    update proposals set status = 'rejected', reason = p_reason where id = suggestion;
  end if;
end $$;

-- An upvote replaces the same player's downvote.
create or replace function public.toggle_upvote(p_idea bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  s settings;
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  select * into s from settings;
  if s.paused then raise exception 'the game is paused'; end if;
  if not exists (select 1 from ideas where id = p_idea and status = 'open') then
    raise exception 'that idea is not on the board';
  end if;
  delete from upvotes where idea_id = p_idea and user_id = auth.uid();
  if found then return; end if;
  delete from downvotes where idea_id = p_idea and user_id = auth.uid();
  insert into upvotes (idea_id, user_id) values (p_idea, auth.uid());
  insert into participation (round, user_id) values (s.round_number, auth.uid())
    on conflict do nothing;
  -- Rule 2: the clock only runs once someone votes.
  update settings set round_closes_at = now() + cycle_interval() where round_closes_at is null;
end $$;

-- A downvote replaces the same player's upvote. An idea leaves once downvotes
-- outnumber upvotes and reach the same share of active players as a major change.
-- "Change nothing" and an idea being built can't be downvoted.
create or replace function public.toggle_downvote(p_idea bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  s settings;
  ups bigint;
  downs bigint;
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  select * into s from settings;
  if s.paused then raise exception 'the game is paused'; end if;
  perform 1 from ideas where id = p_idea and status = 'open' and not is_no_change for update;
  if not found then raise exception 'that idea is not on the board'; end if;
  delete from downvotes where idea_id = p_idea and user_id = auth.uid();
  if found then return; end if;
  delete from upvotes where idea_id = p_idea and user_id = auth.uid();
  insert into downvotes (idea_id, user_id) values (p_idea, auth.uid());
  insert into participation (round, user_id) values (s.round_number, auth.uid())
    on conflict do nothing;
  select count(*) into ups from upvotes where idea_id = p_idea;
  select count(*) into downs from downvotes where idea_id = p_idea;
  if downs > ups and downs >= required_votes('major') then
    perform remove_idea(p_idea, 'Removed by player downvotes.');
  end if;
end $$;

-- Only player suggestions expire. Unvoted AI ideas already clear on each release.
create or replace function public.expire_ideas() returns int
language plpgsql security definer set search_path = public as $$
declare
  cutoff timestamptz := now() - make_interval(days => (select idea_expiry_days from settings));
  stale bigint;
  gone int := 0;
begin
  for stale in
    select i.id from ideas i
    where i.status = 'open' and i.source = 'proposal' and not i.is_no_change
      and i.created_at < cutoff
      and not exists (select 1 from upvotes u where u.idea_id = i.id and u.created_at >= cutoff)
  loop
    perform remove_idea(stale, 'Left the board after going without upvotes.');
    gone := gone + 1;
  end loop;
  return gone;
end $$;

drop function public.board();
create function public.board()
returns table (id bigint, title text, summary text, credit text, size text, need bigint, votes bigint, is_no_change boolean, mine boolean, building boolean, downvotes bigint, mine_down boolean)
language sql stable security definer set search_path = public as $$
  select i.id, i.title, i.spec->>'summary', i.credit, i.size, required_votes(i.size), count(u.user_id), i.is_no_change,
    coalesce(bool_or(u.user_id = auth.uid()), false), i.status = 'won',
    (select count(*) from public.downvotes d where d.idea_id = i.id),
    exists (select 1 from public.downvotes d where d.idea_id = i.id and d.user_id = auth.uid())
  from ideas i
  left join upvotes u on u.idea_id = i.id
  where i.status = 'open'
    or (i.status = 'won' and exists (select 1 from ballots b where b.status = 'building' and b.question = i.title))
  group by i.id
  order by i.status = 'won' desc, i.is_no_change, count(u.user_id) desc, i.id;
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
    'rounds_played', (select count(*) from participation where user_id = auth.uid()));
end $$;

revoke execute on function public.remove_idea(bigint, text) from public, anon, authenticated;
revoke execute on function public.expire_ideas() from public, anon, authenticated;
revoke execute on function public.toggle_downvote(bigint) from public, anon;
grant execute on function public.toggle_downvote(bigint) to authenticated;
revoke execute on function public.board() from public;
grant execute on function public.board() to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('community-game-expire-ideas', '23 * * * *', 'select public.expire_ideas()');
  end if;
end $$;
