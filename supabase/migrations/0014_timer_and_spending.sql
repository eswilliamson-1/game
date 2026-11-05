-- Checks every 10 seconds, and estimates AI spending for the owner. Anthropic
-- doesn't offer a way to read a credit balance, so the owner enters theirs.

alter table public.settings
  add column ai_credit_dollars numeric,
  add column ai_credit_set_at timestamptz;

create table public.ai_spend (
  id bigint generated always as identity primary key,
  job text not null,
  input_tokens bigint not null,
  output_tokens bigint not null,
  dollars numeric not null,
  created_at timestamptz not null default now()
);

alter table public.ai_spend enable row level security;
revoke all on public.ai_spend from anon, authenticated;
grant select, insert on public.ai_spend to service_role;

create or replace function public.spending_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s settings;
begin
  if not is_owner() then raise exception 'owner only'; end if;
  select * into s from settings;
  return jsonb_build_object(
    'today', (select coalesce(sum(dollars), 0) from ai_spend where created_at > now() - interval '1 day'),
    'month', (select coalesce(sum(dollars), 0) from ai_spend where created_at >= date_trunc('month', now())),
    'credit_set', s.ai_credit_dollars,
    'left', s.ai_credit_dollars - (select coalesce(sum(dollars), 0) from ai_spend where created_at > s.ai_credit_set_at));
end $$;

create or replace function public.set_ai_credit(p_dollars numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'owner only'; end if;
  if p_dollars is null or p_dollars < 0 then raise exception 'enter your current credit balance'; end if;
  update settings set ai_credit_dollars = p_dollars, ai_credit_set_at = now() where id;
end $$;

revoke execute on function public.spending_summary() from public, anon;
revoke execute on function public.set_ai_credit(numeric) from public, anon;
grant execute on function public.spending_summary() to authenticated;
grant execute on function public.set_ai_credit(numeric) to authenticated;

-- The winner stays on the board, marked as building, until the new version is out.
drop function public.board();
create function public.board()
returns table (id bigint, title text, summary text, credit text, size text, need bigint, votes bigint, is_no_change boolean, mine boolean, building boolean)
language sql stable security definer set search_path = public as $$
  select i.id, i.title, i.spec->>'summary', i.credit, i.size, required_votes(i.size), count(u.user_id), i.is_no_change,
    coalesce(bool_or(u.user_id = auth.uid()), false), i.status = 'won'
  from ideas i
  left join upvotes u on u.idea_id = i.id
  where i.status = 'open'
    or (i.status = 'won' and exists (select 1 from ballots b where b.status = 'building' and b.question = i.title))
  group by i.id
  order by i.status = 'won' desc, i.is_no_change, count(u.user_id) desc, i.id;
$$;

revoke execute on function public.board() from public;
grant execute on function public.board() to anon, authenticated;

-- Only on the real project: the timer extension isn't in the test database.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('community-game-tick', '10 seconds', 'select public.scheduled_tick()');
  end if;
end $$;
