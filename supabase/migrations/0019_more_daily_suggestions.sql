-- Each player can make ten suggestions a day. The site-wide daily limit still
-- caps what free accounts can spend on AI screening.

alter table public.settings alter column max_proposals_per_day set default 10;

update public.settings set max_proposals_per_day = 10 where id;
