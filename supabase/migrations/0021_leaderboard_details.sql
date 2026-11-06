-- The leaderboard page shows what each player has done. These are counts of
-- public activity, never how anyone voted.

drop function public.leaderboard();
create function public.leaderboard()
returns table (name text, points int, rounds int, on_board int, built int, streak int, last_built text)
language sql stable security definer set search_path = public as $$
  select t.display_name, (t.s->>'points')::int, (t.s->>'votes')::int, (t.s->>'on_ballot')::int,
    (t.s->>'built')::int, (t.s->>'streak')::int,
    (select c.title from changes c
     join ballots b on b.id = c.ballot_id
     join proposals p on p.id = b.proposal_id
     where p.user_id = t.user_id and c.kind = 'vote'
     order by c.id desc limit 1)
  from (
    select pr.display_name, pr.user_id, player_stats(pr.user_id) as s
    from profiles pr where pr.display_name is not null
  ) t
  where (t.s->>'points')::int > 0
  order by (t.s->>'points')::int desc, t.display_name
  limit 50;
$$;

revoke execute on function public.leaderboard() from public, anon, authenticated;
grant execute on function public.leaderboard() to anon, authenticated;
