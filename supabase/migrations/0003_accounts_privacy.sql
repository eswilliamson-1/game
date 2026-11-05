-- Accounts need no email: players sign in anonymously through Supabase Auth.
-- This adds the privacy controls and limits that go with that.

alter table public.settings
  add column max_total_proposals_per_day int not null default 100;

-- A proposal that reached a ballot outlives the player who wrote it, without their name.
alter table public.proposals alter column user_id drop not null;
alter table public.proposals drop constraint proposals_user_id_fkey;
alter table public.proposals add constraint proposals_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

-- Runs on every new proposal. Accounts are free to make, so the per-player limit
-- alone can't cap AI spending, and contact details shouldn't reach the AI at all.
create or replace function public.proposal_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.body ~* '[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]' or new.body ~ '\+?\d[\d ().-]{7,}\d' then
    raise exception 'proposals cannot include contact details';
  end if;
  if (select count(*) from proposals where created_at > now() - interval '1 day')
     >= (select max_total_proposals_per_day from settings) then
    raise exception 'the daily suggestion limit has been reached, so please try again tomorrow';
  end if;
  return new;
end $$;

create trigger proposal_guard before insert on public.proposals
  for each row execute function public.proposal_guard();

-- Finds credit through the proposal, so names a player used earlier are covered too.
create or replace function public.scrub_credit(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update changes set credit = 'a player'
  where ballot_id in (
    select b.id from ballots b join proposals p on p.id = b.proposal_id where p.user_id = p_user
  );
  update ballots set credit = 'a player'
  where proposal_id in (select id from proposals where user_id = p_user);
end $$;

create or replace function public.erase_player(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform scrub_credit(p_user);
  delete from proposals p where p.user_id = p_user
    and not exists (select 1 from ballots b where b.proposal_id = p.id);
  update proposals set body = '[removed]', user_id = null where user_id = p_user;
  -- Removes the profile and votes too, through their foreign keys.
  delete from auth.users where id = p_user;
end $$;

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  if is_owner() then raise exception 'remove this owner in the SQL editor first'; end if;
  perform erase_player(auth.uid());
end $$;

create or replace function public.remove_my_name() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  perform scrub_credit(auth.uid());
  update profiles set display_name = null where user_id = auth.uid();
end $$;

-- Points reward taking part, never which option a player picks, so they can't
-- sway a vote. Each ballot scores once, so extra accounts can't farm points.
create or replace function public.player_stats(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with s as (
    select
      (select count(*) from votes where user_id = p_user) as votes,
      (select count(*) from ballots b join proposals p on p.id = b.proposal_id
       where p.user_id = p_user and b.status in ('open', 'building', 'closed')) as on_ballot,
      (select count(*) from changes c
       join ballots b on b.id = c.ballot_id
       join proposals p on p.id = b.proposal_id
       where p.user_id = p_user and c.kind = 'vote') as built,
      -- Ballots voted on since the last finished ballot this player missed.
      (select count(*) from ballots b
       where exists (select 1 from votes v where v.ballot_id = b.id and v.user_id = p_user)
         and b.id > coalesce((
           select max(m.id) from ballots m
           where m.status in ('building', 'closed')
             and not exists (select 1 from votes v where v.ballot_id = m.id and v.user_id = p_user)
         ), 0)) as streak
  )
  select to_jsonb(s) || jsonb_build_object('points', s.votes + s.on_ballot * 5 + s.built * 20)
  from s;
$$;

create or replace function public.my_progress() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  return player_stats(auth.uid());
end $$;

-- Only players who chose a public name appear, and never with how they voted.
create or replace function public.leaderboard() returns table (name text, points int)
language sql stable security definer set search_path = public as $$
  select t.display_name, t.points from (
    select pr.display_name, (player_stats(pr.user_id)->>'points')::int as points
    from profiles pr where pr.display_name is not null
  ) t
  where t.points > 0
  order by t.points desc, t.display_name
  limit 10;
$$;

create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  return jsonb_build_object(
    'player_id', auth.uid(),
    'public_name', (select display_name from profiles where user_id = auth.uid()),
    'progress', player_stats(auth.uid()),
    'suggestions', coalesce((
      select jsonb_agg(jsonb_build_object('text', body, 'status', status, 'created_at', created_at) order by id)
      from proposals where user_id = auth.uid()), '[]'::jsonb),
    'votes', coalesce((
      select jsonb_agg(jsonb_build_object('question', b.question, 'choice', o.label, 'created_at', v.created_at) order by v.created_at)
      from votes v join ballots b on b.id = v.ballot_id join options o on o.id = v.option_id
      where v.user_id = auth.uid()), '[]'::jsonb));
end $$;

-- Runs daily. The periods here must match the privacy page.
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
        (select max(created_at) from proposals p where p.user_id = u.id)
      ) < now() - interval '1 year'
  loop
    perform erase_player(stale);
    removed := removed + 1;
  end loop;

  return jsonb_build_object('proposals_cleared', cleared, 'accounts_removed', removed);
end $$;

revoke execute on function public.proposal_guard() from public, anon, authenticated;
revoke execute on function public.scrub_credit(uuid) from public, anon, authenticated;
revoke execute on function public.erase_player(uuid) from public, anon, authenticated;
revoke execute on function public.delete_my_account() from public, anon, authenticated;
revoke execute on function public.remove_my_name() from public, anon, authenticated;
revoke execute on function public.export_my_data() from public, anon, authenticated;
revoke execute on function public.purge_old_data() from public, anon, authenticated;
revoke execute on function public.player_stats(uuid) from public, anon, authenticated;
revoke execute on function public.my_progress() from public, anon, authenticated;
revoke execute on function public.leaderboard() from public, anon, authenticated;
grant execute on function public.my_progress() to authenticated;
grant execute on function public.leaderboard() to anon, authenticated;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.remove_my_name() to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.purge_old_data() to service_role;
