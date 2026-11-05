-- Lets the site show which stage a build has reached.

alter table public.ballots
  add column build_stage text not null default 'writing'
    check (build_stage in ('writing', 'testing', 'fixing', 'publishing'));
