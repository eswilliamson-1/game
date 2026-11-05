-- With few players, a major change no longer needs a fixed three upvotes. Its
-- target is half of the active players, so it starts at one and grows with them.

alter table public.settings alter column size_rules set default
  '{"medium": {"min": 1, "share": 0.25}, "major": {"min": 1, "share": 0.5}}';

update public.settings set size_rules = jsonb_set(size_rules, '{major,min}', '1') where id;
