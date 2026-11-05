-- AI ideas are written for one version of the game, so each release clears unvoted ones
-- and asks for new ones. Player ideas and voted ideas stay, and are rechecked if they win.

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
    update settings set last_ai_ideas_at = null;
  end if;
end $$;
