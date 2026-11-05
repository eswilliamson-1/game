-- Supabase refuses an UPDATE with no WHERE clause from the website and pipeline,
-- so functions they call must name the one settings row.

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
  if p_ok then
    -- Ideas with votes stay, so nobody's vote disappears. They're rechecked if they win.
    update ideas i set status = 'rejected'
    where i.source = 'ai' and i.status in ('open', 'pending_review')
      and not exists (select 1 from upvotes u where u.idea_id = i.id);
    update settings set last_ai_ideas_at = null where id;
  end if;
end $$;

create or replace function public.set_paused(p_paused boolean, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only'; end if;
  update settings set paused = p_paused where id;
  insert into changes (kind, title, notes)
  values (case when p_paused then 'pause' else 'resume' end,
          case when p_paused then 'Game paused by the owner' else 'Game resumed by the owner' end,
          coalesce(p_reason, ''));
end $$;

-- Signal Sorter went live, but this bug stopped it being recorded.
do $$
begin
  if exists (select 1 from public.ballots where id = 5 and status = 'building') then
    perform public.complete_build(5, true, 'v1', 'Signal Sorter',
      'The first playable game. Flick colored shapes into the matching bins before they reach the end of the conveyor. It speeds up as your score climbs.');
  end if;
end $$;
