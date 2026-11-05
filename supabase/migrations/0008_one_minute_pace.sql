-- With only a few players, voting windows last one minute.

alter table public.settings alter column pace_tiers set default
  '[{"players": 5, "minutes": 1}, {"players": 25, "minutes": 30}, {"players": 100, "minutes": 120}]';
alter table public.settings alter column plan_throttle_minutes set default 1;

update public.settings set
  pace_tiers = '[{"players": 5, "minutes": 1}, {"players": 25, "minutes": 30}, {"players": 100, "minutes": 120}]',
  plan_throttle_minutes = 1;
