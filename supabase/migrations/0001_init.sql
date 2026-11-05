-- Core data and voting rules. The rules that matter most are enforced here,
-- so a bug or a tricked AI in the pipeline can't get around them.

create table public.settings (
  id boolean primary key default true check (id),
  paused boolean not null default false,
  launch_review boolean not null default true,
  -- Young games move faster: the cycle lengthens as releases accumulate.
  fast_cycle_minutes int not null default 30 check (fast_cycle_minutes > 0),
  fast_until_releases int not null default 10,
  medium_cycle_minutes int not null default 120 check (medium_cycle_minutes > 0),
  medium_until_releases int not null default 25,
  cycle_hours int not null default 6 check (cycle_hours > 0),
  max_proposals_per_day int not null default 3,
  max_proposal_chars int not null default 280,
  last_plan_dispatch_at timestamptz
);
insert into public.settings default values;

create table public.owners (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- Public names for credit. Emails are never shown.
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text unique
);

create table public.proposals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'on_ballot', 'held', 'rejected')),
  title text,
  spec jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create table public.ballots (
  id bigint generated always as identity primary key,
  question text not null,
  source text not null check (source in ('ai', 'proposal')),
  proposal_id bigint references public.proposals (id),
  credit text not null default 'the AI',
  status text not null
    check (status in ('pending_review', 'open', 'building', 'closed', 'rejected')),
  closes_at timestamptz,
  winner_option_id bigint,
  outcome text,
  build_dispatched_at timestamptz,
  created_at timestamptz not null default now()
);

-- One change per cycle: only one ballot can be active at a time.
create unique index one_active_ballot on public.ballots ((true))
  where status in ('pending_review', 'open', 'building');

create table public.options (
  id bigint generated always as identity primary key,
  ballot_id bigint not null references public.ballots (id) on delete cascade,
  label text not null,
  spec jsonb,
  is_no_change boolean not null default false
);
create unique index one_no_change_option on public.options (ballot_id) where is_no_change;

create table public.votes (
  ballot_id bigint not null references public.ballots (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  option_id bigint not null references public.options (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ballot_id, user_id)
);

-- Public history: patch notes, failed builds, fixes, and owner controls.
create table public.changes (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('vote', 'fix', 'failed', 'rollback', 'pause', 'resume')),
  ballot_id bigint references public.ballots (id),
  version text,
  credit text,
  title text not null,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create or replace function public.cycle_interval() returns interval
language sql stable security definer set search_path = public as $$
  select case
    when r.n < s.fast_until_releases then make_interval(mins => s.fast_cycle_minutes)
    when r.n < s.medium_until_releases then make_interval(mins => s.medium_cycle_minutes)
    else make_interval(hours => s.cycle_hours)
  end
  from settings s, (select count(*) n from changes where kind = 'vote') r;
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from owners where user_id = auth.uid());
$$;

alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.owners enable row level security;
alter table public.proposals enable row level security;
alter table public.ballots enable row level security;
alter table public.options enable row level security;
alter table public.votes enable row level security;
alter table public.changes enable row level security;

create policy profiles_read on public.profiles for select
  using (user_id = auth.uid() or is_owner());
create policy settings_read on public.settings for select using (true);
create policy owners_read on public.owners for select using (is_owner());
create policy proposals_read on public.proposals for select
  using (user_id = auth.uid() or is_owner());
create policy ballots_read on public.ballots for select
  using (status <> 'pending_review' or is_owner());
create policy options_read on public.options for select using (
  exists (select 1 from ballots b where b.id = ballot_id)
);
create policy votes_read on public.votes for select using (user_id = auth.uid());
create policy changes_read on public.changes for select using (true);

-- Public view of proposals. It never exposes the raw text or who wrote it,
-- so a rejected proposal can't be used to publish something off-limits.
create view public.public_proposals as
  select id, title, status, reason, created_at
  from public.proposals
  where status in ('queued', 'on_ballot', 'rejected');

create or replace function public.ballot_results(p_ballot bigint)
returns table (option_id bigint, votes bigint)
language sql stable security definer set search_path = public as $$
  select o.id, count(v.user_id)
  from options o
  join ballots b on b.id = o.ballot_id and b.status <> 'pending_review'
  left join votes v on v.option_id = o.id
  where o.ballot_id = p_ballot
  group by o.id;
$$;

create or replace function public.set_display_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  p_name := btrim(p_name);
  if p_name !~ '^[A-Za-z0-9][A-Za-z0-9 _-]{1,23}$' then
    raise exception 'names must be 2 to 24 letters, numbers, spaces, dashes, or underscores';
  end if;
  if p_name ~* '(admin|owner|moderator|\ymod\y|staff|official|claude|anthropic|support|system|ewpages)' then
    raise exception 'that name is reserved';
  end if;
  insert into profiles (user_id, display_name) values (auth.uid(), p_name)
  on conflict (user_id) do update set display_name = excluded.display_name;
exception when unique_violation then
  raise exception 'that name is taken';
end $$;

-- Lets the owner remove an offensive name. Credit falls back to "a player".
create or replace function public.clear_display_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only'; end if;
  update profiles set display_name = null where display_name = p_name;
  update ballots set credit = 'a player' where credit = p_name;
  update changes set credit = 'a player' where credit = p_name;
end $$;

create or replace function public.submit_proposal(p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  s settings;
  new_id bigint;
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  select * into s from settings;
  if s.paused then raise exception 'the game is paused'; end if;
  p_body := btrim(p_body);
  if length(p_body) = 0 or length(p_body) > s.max_proposal_chars then
    raise exception 'proposals must be 1 to % characters', s.max_proposal_chars;
  end if;
  if p_body ~* '(https?:|www\.|[a-z0-9-]+\.(com|net|org|io|gg|ru|xyz)\y|<[a-z/!?]|```|\{\{|\$\{)' then
    raise exception 'proposals must be plain text with no links or code';
  end if;
  if p_body ~ '[\u0001-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁤﻿]' then
    raise exception 'proposals cannot contain hidden characters';
  end if;
  if (select count(*) from proposals
      where user_id = auth.uid() and created_at > now() - interval '1 day')
     >= s.max_proposals_per_day then
    raise exception 'daily proposal limit reached';
  end if;
  insert into proposals (user_id, body) values (auth.uid(), p_body) returning id into new_id;
  return new_id;
end $$;

create or replace function public.cast_vote(p_ballot bigint, p_option bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  if (select paused from settings) then raise exception 'the game is paused'; end if;
  if not exists (select 1 from ballots where id = p_ballot and status = 'open') then
    raise exception 'this ballot is not open';
  end if;
  if not exists (select 1 from options where id = p_option and ballot_id = p_ballot) then
    raise exception 'that option is not on this ballot';
  end if;
  insert into votes (ballot_id, user_id, option_id) values (p_ballot, auth.uid(), p_option)
  on conflict (ballot_id, user_id) do update set option_id = excluded.option_id, created_at = now();
end $$;

-- The "do not do this change" option is added here, so no ballot can exist without it.
create or replace function public.create_ballot(
  p_question text, p_source text, p_proposal bigint, p_options jsonb, p_flagged boolean
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  s settings;
  new_id bigint;
  opt jsonb;
  needs_review boolean;
  who text := 'the AI';
begin
  select * into s from settings;
  if p_proposal is not null then
    select coalesce(pr.display_name, 'a player') into who
    from proposals p left join profiles pr on pr.user_id = p.user_id
    where p.id = p_proposal;
  end if;
  if jsonb_array_length(p_options) < 1 then raise exception 'a ballot needs a change to vote on'; end if;
  needs_review := s.launch_review or p_flagged;
  insert into ballots (question, source, proposal_id, credit, status, closes_at)
  values (p_question, p_source, p_proposal, who,
          case when needs_review then 'pending_review' else 'open' end,
          case when needs_review then null else now() + cycle_interval() end)
  returning id into new_id;
  for opt in select * from jsonb_array_elements(p_options) loop
    insert into options (ballot_id, label, spec) values (new_id, opt->>'label', opt->'spec');
  end loop;
  insert into options (ballot_id, label, is_no_change) values (new_id, 'Do not do this change', true);
  if p_proposal is not null then
    update proposals set status = 'on_ballot' where id = p_proposal;
  end if;
  return new_id;
end $$;

create or replace function public.review_ballot(p_ballot bigint, p_approve boolean, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  b ballots;
begin
  if not is_owner() then raise exception 'owner only'; end if;
  select * into b from ballots where id = p_ballot and status = 'pending_review' for update;
  if not found then raise exception 'that ballot is not waiting for review'; end if;
  if p_approve then
    update ballots set status = 'open',
      closes_at = now() + cycle_interval()
    where id = p_ballot;
  else
    if coalesce(btrim(p_reason), '') = '' then raise exception 'a rejection needs a public reason'; end if;
    update ballots set status = 'rejected', outcome = p_reason where id = p_ballot;
    update proposals set status = 'rejected', reason = p_reason where id = b.proposal_id;
  end if;
end $$;

create or replace function public.review_proposal(p_proposal bigint, p_approve boolean, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only'; end if;
  if not exists (select 1 from proposals where id = p_proposal and status = 'held') then
    raise exception 'that proposal is not on hold';
  end if;
  if p_approve then
    -- Approved proposals go back through screening, so a person can't
    -- accidentally wave through an unchecked spec.
    update proposals set status = 'pending' , reason = 'owner_approved' where id = p_proposal;
  else
    if coalesce(btrim(p_reason), '') = '' then raise exception 'a rejection needs a public reason'; end if;
    update proposals set status = 'rejected', reason = p_reason where id = p_proposal;
  end if;
end $$;

create or replace function public.set_paused(p_paused boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only'; end if;
  update settings set paused = p_paused;
  insert into changes (kind, title, notes)
  values (case when p_paused then 'pause' else 'resume' end,
          case when p_paused then 'Game paused by the owner' else 'Game resumed by the owner' end,
          coalesce(p_reason, ''));
end $$;

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
     and s.last_plan_dispatch_at > now() - interval '10 minutes' then
    needs_plan := false;
  end if;
  if needs_plan then update settings set last_plan_dispatch_at = now(); end if;

  return jsonb_build_object('build', to_jsonb(to_build), 'plan', needs_plan);
end $$;

create or replace function public.complete_build(
  p_ballot bigint, p_ok boolean, p_version text, p_title text, p_notes text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update ballots set status = 'closed',
    outcome = case when p_ok then 'Built and released as ' || p_version else p_notes end
  where id = p_ballot and status = 'building';
  if not found then raise exception 'that ballot is not building'; end if;
  insert into changes (kind, ballot_id, version, credit, title, notes)
  select case when p_ok then 'vote' else 'failed' end, p_ballot, p_version, b.credit, p_title, p_notes
  from ballots b where b.id = p_ballot;
end $$;

-- Functions are callable by everyone by default, so access is granted explicitly.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_owner() to anon, authenticated;
grant execute on function public.cycle_interval() to anon, authenticated, service_role;
grant execute on function public.ballot_results(bigint) to anon, authenticated;
grant execute on function public.submit_proposal(text) to authenticated;
grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.clear_display_name(text) to authenticated;
grant execute on function public.cast_vote(bigint, bigint) to authenticated;
grant execute on function public.review_ballot(bigint, boolean, text) to authenticated;
grant execute on function public.review_proposal(bigint, boolean, text) to authenticated;
grant execute on function public.set_paused(boolean, text) to authenticated;
grant execute on function public.create_ballot(text, text, bigint, jsonb, boolean) to service_role;
grant execute on function public.tick() to service_role;
grant execute on function public.complete_build(bigint, boolean, text, text, text) to service_role;

grant select on public.settings, public.ballots, public.options, public.changes, public.public_proposals
  to anon, authenticated;
grant select on public.proposals, public.votes, public.owners, public.profiles to authenticated;
revoke insert, update, delete on all tables in schema public from anon, authenticated;
grant select, insert, update on all tables in schema public to service_role;
