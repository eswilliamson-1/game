-- A major change needs a third of the active players, so one upvote is enough
-- with up to three of them.

alter table public.settings alter column size_rules set default
  '{"medium": {"min": 1, "share": 0.25}, "major": {"min": 1, "share": 0.33}}';

update public.settings set size_rules = jsonb_set(size_rules, '{major,share}', '0.33') where id;
