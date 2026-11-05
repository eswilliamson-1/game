-- A player counts as active for three days after they last upvoted or suggested.
-- Upvote targets and the round timer both follow this count.

alter table public.settings alter column active_days set default 3;

update public.settings set active_days = 3 where id;
