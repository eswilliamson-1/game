-- Replaces one-at-a-time ballots with a public idea board. Players upvote any
-- ideas, and when a round ends the top idea is built. The ballots and options
-- tables stay as the record the build system reads.

alter table public.settings
  add column round_number int not null default 1,
  add column round_closes_at timestamptz,
  add column last_round_result text,
  add column min_ideas int not null default 3,
  add column ai_ideas_every_minutes int not null default 30 check (ai_ideas_every_minutes > 0),
  add column last_ai_ideas_at timestamptz;

create table public.ideas (
  id bigint generated always as identity primary key,
  title text not null,
  spec jsonb,
  source text not null check (source in ('ai', 'proposal', 'rules')),
  proposal_id bigint references public.proposals (id),
  credit text not null default 'the AI',
  status text not null check (status in ('pending_review', 'open', 'won', 'rejected')),
  is_no_change boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index one_no_change_idea on public.ideas ((true)) where is_no_change;

create table public.upvotes (
  idea_id bigint not null references public.ideas (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (idea_id, user_id)
);

-- Points and streaks count rounds, so upvoting many ideas earns nothing extra.
create table public.participation (
  round int not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (round, user_id)
);

alter table public.ideas enable row level security;
alter table public.upvotes enable row level security;
alter table public.participation enable row level security;
create policy ideas_read on public.ideas for select using (is_owner());

revoke all on public.ideas, public.upvotes, public.participation from anon, authenticated;
grant select on public.ideas to authenticated;
grant select, insert, update on public.ideas, public.upvotes, public.participation to service_role;

-- Rule 3: this is always on the board, and ties go to it.
insert into public.ideas (title, source, credit, status, is_no_change)
values ('Change nothing this round', 'rules', 'the rules', 'open', true);

-- Moves anything on a live ballot onto the board.
insert into public.ideas (title, spec, source, proposal_id, credit, status)
select o.label, o.spec, b.source, b.proposal_id, b.credit,
  case when b.status = 'pending_review' then 'pending_review' else 'open' end
from public.options o
join public.ballots b on b.id = o.ballot_id
where b.status in ('open', 'pending_review') and not o.is_no_change;

update public.ballots set status = 'closed', outcome = 'Moved to the idea board.'
where status in ('open', 'pending_review');

create or replace function public.add_idea(
  p_title text, p_spec jsonb, p_source text, p_proposal bigint, p_flagged boolean
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  who text := 'the AI';
  new_id bigint;
begin
  if p_proposal is not null then
    select coalesce(pr.display_name, 'a player') into who
    from proposals p left join profiles pr on pr.user_id = p.user_id
    where p.id = p_proposal;
    update proposals set status = 'on_ballot' where id = p_proposal;
  end if;
  insert into ideas (title, spec, source, proposal_id, credit, status)
  values (p_title, p_spec, p_source, p_proposal, who,
          case when p_flagged or (select launch_review from settings) then 'pending_review' else 'open' end)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.board()
returns table (id bigint, title text, summary text, credit text, votes bigint, is_no_change boolean, mine boolean)
language sql stable security definer set search_path = public as $$
  select i.id, i.title, i.spec->>'summary', i.credit, count(u.user_id), i.is_no_change,
    coalesce(bool_or(u.user_id = auth.uid()), false)
  from ideas i
  left join upvotes u on u.idea_id = i.id
  where i.status = 'open'
  group by i.id
  order by i.is_no_change, count(u.user_id) desc, i.id;
$$;

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
  insert into upvotes (idea_id, user_id) values (p_idea, auth.uid());
  insert into participation (round, user_id) values (s.round_number, auth.uid())
    on conflict do nothing;
  -- Rule 2: the clock only runs once someone votes.
  update settings set round_closes_at = now() + cycle_interval() where round_closes_at is null;
end $$;

create or replace function public.review_idea(p_idea bigint, p_approve boolean, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  i ideas;
begin
  if not is_owner() then raise exception 'owner only'; end if;
  select * into i from ideas where id = p_idea and status = 'pending_review' for update;
  if not found then raise exception 'that idea is not waiting for review'; end if;
  if p_approve then
    update ideas set status = 'open' where id = p_idea;
  else
    if coalesce(btrim(p_reason), '') = '' then raise exception 'a rejection needs a public reason'; end if;
    update ideas set status = 'rejected' where id = p_idea;
    update proposals set status = 'rejected', reason = p_reason where id = i.proposal_id;
  end if;
end $$;

-- Runs on a timer. It only does database work, so a quiet game costs nothing.
create or replace function public.tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s settings;
  top ideas;
  top_votes bigint;
  top_count int;
  new_ballot bigint;
  new_option bigint;
  result text;
  to_build bigint[] := '{}';
  needs_plan boolean;
begin
  select * into s from settings;
  if s.paused then return jsonb_build_object('paused', true); end if;

  -- A round can't close while a change is building, so builds never overlap.
  if s.round_closes_at <= now()
     and not exists (select 1 from ballots where status = 'building') then
    select max(c), count(*) filter (where c = m.top) into top_votes, top_count
    from (select count(u.user_id) c from ideas i left join upvotes u on u.idea_id = i.id
          where i.status = 'open' group by i.id) t,
         (select max(c2) top from (select count(u.user_id) c2 from ideas i
            left join upvotes u on u.idea_id = i.id
            where i.status = 'open' group by i.id) x) m;

    if top_votes = 0 then
      -- Everyone took their votes back, so the round simply hasn't started.
      update settings set round_closes_at = null;
    else
      if top_count > 1 then
        result := format('Round %s was a tie, so nothing changed.', s.round_number);
      else
        select i.* into top from ideas i
        join upvotes u on u.idea_id = i.id
        where i.status = 'open'
        group by i.id order by count(*) desc limit 1;

        if top.is_no_change then
          result := format('Round %s: players chose to change nothing.', s.round_number);
        else
          insert into ballots (question, source, proposal_id, credit, status)
          values (top.title, case when top.source = 'proposal' then 'proposal' else 'ai' end,
                  top.proposal_id, top.credit, 'building')
          returning id into new_ballot;
          insert into options (ballot_id, label, spec)
          values (new_ballot, top.title, top.spec) returning id into new_option;
          update ballots set winner_option_id = new_option where id = new_ballot;
          update ideas set status = 'won' where id = top.id;
          result := format('Round %s: "%s" won.', s.round_number, top.title);
        end if;
      end if;
      -- Votes on other ideas carry over, but "change nothing" starts each round at zero.
      delete from upvotes where idea_id = (select id from ideas where is_no_change);
      update settings set round_number = round_number + 1, round_closes_at = null,
        last_round_result = result;
    end if;
  end if;

  -- Also retries a build whose start signal was lost.
  with due as (
    update ballots set build_dispatched_at = now()
    where status = 'building'
      and (build_dispatched_at is null or build_dispatched_at < now() - interval '2 hours')
    returning id
  ) select coalesce(array_agg(id), '{}') into to_build from due;

  needs_plan := exists (select 1 from proposals where status in ('pending', 'queued'))
    or ((select count(*) from ideas
         where status in ('open', 'pending_review') and not is_no_change) < s.min_ideas
        and (s.last_ai_ideas_at is null
             or s.last_ai_ideas_at < now() - make_interval(mins => s.ai_ideas_every_minutes)));

  if needs_plan and s.last_plan_dispatch_at is not null
     and s.last_plan_dispatch_at > now() - make_interval(mins => s.plan_throttle_minutes) then
    needs_plan := false;
  end if;
  if needs_plan then update settings set last_plan_dispatch_at = now(); end if;

  return jsonb_build_object('build', to_jsonb(to_build), 'plan', needs_plan);
end $$;

create or replace function public.player_stats(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (
    select
      (select count(*) from votes where user_id = p_user)
        + (select count(*) from participation where user_id = p_user) as votes,
      (select count(*) from ideas i join proposals p on p.id = i.proposal_id
       where p.user_id = p_user and i.status in ('open', 'won')) as on_ballot,
      (select count(*) from changes c
       join ballots b on b.id = c.ballot_id
       join proposals p on p.id = b.proposal_id
       where p.user_id = p_user and c.kind = 'vote') as built,
      -- Rounds played since the last finished round this player missed.
      (select count(*) from participation pa
       where pa.user_id = p_user
         and pa.round > coalesce((
           select max(n) from generate_series(1, (select round_number - 1 from settings)) n
           where not exists (select 1 from participation m where m.round = n and m.user_id = p_user)
         ), 0)) as streak
  )
  select to_jsonb(s) || jsonb_build_object('points', s.votes + s.on_ballot * 5 + s.built * 20)
  from s;
$$;

create or replace function public.active_players() returns bigint
language sql stable security definer set search_path = public as $$
  select count(distinct user_id) from (
    select user_id from participation
    where created_at > now() - make_interval(days => (select active_days from settings))
    union all
    select user_id from proposals
    where created_at > now() - make_interval(days => (select active_days from settings))
  ) recent;
$$;

create or replace function public.scrub_credit(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update changes set credit = 'a player'
  where ballot_id in (
    select b.id from ballots b join proposals p on p.id = b.proposal_id where p.user_id = p_user
  );
  update ballots set credit = 'a player'
  where proposal_id in (select id from proposals where user_id = p_user);
  update ideas set credit = 'a player'
  where proposal_id in (select id from proposals where user_id = p_user);
end $$;

create or replace function public.erase_player(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform scrub_credit(p_user);
  delete from proposals p where p.user_id = p_user
    and not exists (select 1 from ballots b where b.proposal_id = p.id)
    and not exists (select 1 from ideas i where i.proposal_id = p.id);
  update proposals set body = '[removed]', user_id = null where user_id = p_user;
  -- Removes the profile, votes, and upvotes too, through their foreign keys.
  delete from auth.users where id = p_user;
end $$;

create or replace function public.clear_display_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only'; end if;
  update profiles set display_name = null where display_name = p_name;
  update ballots set credit = 'a player' where credit = p_name;
  update changes set credit = 'a player' where credit = p_name;
  update ideas set credit = 'a player' where credit = p_name;
end $$;

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
    'rounds_played', (select count(*) from participation where user_id = auth.uid()));
end $$;

create or replace function public.purge_old_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  stale uuid;
  removed int := 0;
  cleared int;
begin
  update proposals set body = '[removed]'
  where status in ('queued', 'on_ballot', 'rejected')
    and created_at < now() - interval '30 days'
    and body <> '[removed]';
  get diagnostics cleared = row_count;

  for stale in
    select u.id from auth.users u
    where not exists (select 1 from owners o where o.user_id = u.id)
      and greatest(
        u.created_at,
        u.last_sign_in_at,
        (select max(created_at) from votes v where v.user_id = u.id),
        (select max(created_at) from participation pa where pa.user_id = u.id),
        (select max(created_at) from proposals p where p.user_id = u.id)
      ) < now() - interval '1 year'
  loop
    perform erase_player(stale);
    removed := removed + 1;
  end loop;

  return jsonb_build_object('proposals_cleared', cleared, 'accounts_removed', removed);
end $$;

revoke execute on function public.add_idea(text, jsonb, text, bigint, boolean) from public, anon, authenticated;
revoke execute on function public.board() from public;
revoke execute on function public.toggle_upvote(bigint) from public, anon;
revoke execute on function public.review_idea(bigint, boolean, text) from public, anon;
revoke execute on function public.cast_vote(bigint, bigint) from authenticated;
revoke execute on function public.review_ballot(bigint, boolean, text) from authenticated;
grant execute on function public.add_idea(text, jsonb, text, bigint, boolean) to service_role;
grant execute on function public.board() to anon, authenticated;
grant execute on function public.toggle_upvote(bigint) to authenticated;
grant execute on function public.review_idea(bigint, boolean, text) to authenticated;
