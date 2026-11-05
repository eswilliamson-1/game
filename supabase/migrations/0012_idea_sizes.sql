-- Bigger changes need more upvotes. The reviewer rates each idea, and the target
-- scales with the number of active players.

alter table public.settings
  add column size_rules jsonb not null default
    '{"medium": {"min": 2, "share": 0.25}, "major": {"min": 3, "share": 0.5}}';

alter table public.ideas
  add column size text not null default 'small' check (size in ('small', 'medium', 'major'));

-- Everything on the board now was written as a whole game, which is a major
-- change once a game exists.
update public.ideas set size = 'major' where status in ('open', 'pending_review') and not is_no_change;

-- The first game is free: anything can start it with one vote.
create or replace function public.required_votes(p_size text) returns bigint
language sql stable security definer set search_path = public as $$
  select case
    when p_size = 'small' or not exists (select 1 from changes where kind = 'vote') then 1
    else greatest(
      (s.size_rules->p_size->>'min')::bigint,
      ceil(active_players() * (s.size_rules->p_size->>'share')::numeric)::bigint)
  end
  from settings s;
$$;

create or replace function public.vote_tally()
returns table (id bigint, votes bigint, need bigint)
language sql stable security definer set search_path = public as $$
  select i.id, count(u.user_id), required_votes(i.size)
  from ideas i
  left join upvotes u on u.idea_id = i.id
  where i.status = 'open'
  group by i.id;
$$;

drop function public.add_idea(text, jsonb, text, bigint, boolean);
create function public.add_idea(
  p_title text, p_spec jsonb, p_source text, p_proposal bigint, p_flagged boolean, p_size text default 'small'
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
  insert into ideas (title, spec, source, proposal_id, credit, size, status)
  values (p_title, p_spec, p_source, p_proposal, who, p_size,
          case when p_flagged or (select launch_review from settings) then 'pending_review' else 'open' end)
  returning id into new_id;
  return new_id;
end $$;

drop function public.board();
create function public.board()
returns table (id bigint, title text, summary text, credit text, size text, need bigint, votes bigint, is_no_change boolean, mine boolean)
language sql stable security definer set search_path = public as $$
  select i.id, i.title, i.spec->>'summary', i.credit, i.size, required_votes(i.size), count(u.user_id), i.is_no_change,
    coalesce(bool_or(u.user_id = auth.uid()), false)
  from ideas i
  left join upvotes u on u.idea_id = i.id
  where i.status = 'open'
  group by i.id
  order by i.is_no_change, count(u.user_id) desc, i.id;
$$;

create or replace function public.set_idea_size(p_idea bigint, p_size text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only'; end if;
  update ideas set size = p_size where id = p_idea and not is_no_change;
end $$;

-- Runs on a timer. It only does database work, so a quiet game costs nothing.
create or replace function public.tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s settings;
  top ideas;
  total bigint;
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
    select coalesce(sum(t.votes), 0), max(t.votes) filter (where t.votes >= t.need)
      into total, top_votes from vote_tally() t;
    select count(*) into top_count from vote_tally() t
      where t.votes = top_votes and t.votes >= t.need;

    if total = 0 then
      -- Everyone took their votes back, so the round simply hasn't started.
      update settings set round_closes_at = null;
    else
      if top_votes is null then
        result := format('Round %s: no idea reached its upvote target, so nothing changed.', s.round_number);
      elsif top_count > 1 then
        result := format('Round %s was a tie, so nothing changed.', s.round_number);
      else
        select i.* into top from ideas i
        join vote_tally() t on t.id = i.id
        where t.votes = top_votes and t.votes >= t.need
        limit 1;

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

revoke execute on function public.required_votes(text) from public, anon, authenticated;
revoke execute on function public.vote_tally() from public, anon, authenticated;
revoke execute on function public.add_idea(text, jsonb, text, bigint, boolean, text) from public, anon, authenticated;
revoke execute on function public.board() from public;
revoke execute on function public.set_idea_size(bigint, text) from public, anon;
grant execute on function public.add_idea(text, jsonb, text, bigint, boolean, text) to service_role;
grant execute on function public.board() to anon, authenticated;
grant execute on function public.set_idea_size(bigint, text) to authenticated;
