-- Players log in with a username and password. Supabase Auth needs an email
-- field, so the site fills it with username@players.ewpages.com. Nothing is
-- ever sent there. This keeps real addresses out, even through the raw API.

create or replace function public.account_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and new.email !~ '^[a-z0-9_-]{3,24}@players\.ewpages\.com$' then
    raise exception 'accounts use a username, not an email address';
  end if;
  return new;
end $$;

create trigger account_guard before insert or update of email on auth.users
  for each row execute function public.account_guard();

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
      where v.user_id = auth.uid()), '[]'::jsonb));
end $$;

revoke execute on function public.account_guard() from public, anon, authenticated;
revoke execute on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
