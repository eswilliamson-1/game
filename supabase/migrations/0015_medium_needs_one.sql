-- With only one or two players, a medium change needs a single upvote. The share
-- still raises the target as more people play.

alter table public.settings alter column size_rules set default
  '{"medium": {"min": 1, "share": 0.25}, "major": {"min": 3, "share": 0.5}}';

update public.settings set size_rules = jsonb_set(size_rules, '{medium,min}', '1') where id;
