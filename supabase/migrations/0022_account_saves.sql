-- One small game save per account, so progress follows a player between devices.
-- It's opaque text written by the game: stored and handed back, never shown or run.
-- It goes when the account goes, through the foreign key.

create table public.game_saves (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data text not null check (char_length(data) <= 32000),
  updated_at timestamptz not null default now()
);

alter table public.game_saves enable row level security;
revoke all on public.game_saves from anon, authenticated;

create or replace function public.load_game_save() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  return (select data from game_saves where user_id = auth.uid());
end $$;

-- The site spaces out writes, and this holds even if a page doesn't.
create or replace function public.store_game_save(p_data text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  if p_data is null or char_length(p_data) > 32000 then raise exception 'that save is too large'; end if;
  insert into game_saves (user_id, data) values (auth.uid(), p_data)
  on conflict (user_id) do update set data = excluded.data, updated_at = now()
    where game_saves.updated_at < now() - interval '2 seconds';
  return found;
end $$;

create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login required'; end if;
  return jsonb_build_object(
    'player_id', auth.uid(),
    'username', (select split_part(email, '@', 1) from auth.users where id = auth.uid()),
    'public_name', (select display_name from profiles where user_id = auth.uid()),
    'progress', player_stats(auth.uid()),
    'suggestions', coalesce((
      select jsonb_agg(jsonb_build_object('text', body, 'status', status, 'created_at', created_at) order by id)
      from proposals where user_id = auth.uid()), '[]'::jsonb),
    'votes', coalesce((
      select jsonb_agg(jsonb_build_object('question', b.question, 'choice', o.label, 'created_at', v.created_at) order by v.created_at)
      from votes v join ballots b on b.id = v.ballot_id join options o on o.id = v.option_id
      where v.user_id = auth.uid()), '[]'::jsonb),
    'upvotes', coalesce((
      select jsonb_agg(jsonb_build_object('idea', i.title, 'created_at', u.created_at) order by u.created_at)
      from upvotes u join ideas i on i.id = u.idea_id
      where u.user_id = auth.uid()), '[]'::jsonb),
    'downvotes', coalesce((
      select jsonb_agg(jsonb_build_object('idea', i.title, 'created_at', d.created_at) order by d.created_at)
      from downvotes d join ideas i on i.id = d.idea_id
      where d.user_id = auth.uid()), '[]'::jsonb),
    'game_save', (select data from game_saves where user_id = auth.uid()),
    'rounds_played', (select count(*) from participation where user_id = auth.uid()));
end $$;

revoke execute on function public.load_game_save() from public, anon;
revoke execute on function public.store_game_save(text) from public, anon;
grant execute on function public.load_game_save() to authenticated;
grant execute on function public.store_game_save(text) to authenticated;
