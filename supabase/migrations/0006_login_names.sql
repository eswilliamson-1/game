-- A player's login username is also their public name, so names are checked
-- when the account is made and can't be changed afterwards.

create or replace function public.account_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and new.email !~ '^[a-z0-9_-]{3,24}@players\.ewpages\.com$' then
    raise exception 'accounts use a username, not an email address';
  end if;
  if split_part(new.email, '@', 1) ~* '(admin|owner|moderator|\ymod\y|staff|official|claude|anthropic|support|system|ewpages)' then
    raise exception 'that username is reserved';
  end if;
  return new;
end $$;

create or replace function public.add_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null then
    insert into profiles (user_id, display_name)
    values (new.id, split_part(new.email, '@', 1))
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;

create trigger add_profile after insert on auth.users
  for each row execute function public.add_profile();

-- Accounts made before this change, including any that had a separate public name.
insert into public.profiles (user_id, display_name)
select id, split_part(email, '@', 1) from auth.users where email is not null
on conflict (user_id) do update set display_name = excluded.display_name;

revoke execute on function public.add_profile() from public, anon, authenticated;
revoke execute on function public.set_display_name(text) from public, anon, authenticated;
revoke execute on function public.remove_my_name() from public, anon, authenticated;
