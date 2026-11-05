#!/usr/bin/env bash
# Applies each migration once, in order. A failed file rolls back and stops the run.
set -euo pipefail

# Files up to this one were run by hand before this script existed.
BASELINE="0014_timer_and_spending.sql"

run() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -X -q "$@"; }

run -c "create table if not exists public.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;"

if [ "$(run -At -c 'select count(*) from public.schema_migrations')" = "0" ]; then
  for file in supabase/migrations/*.sql; do
    name="$(basename "$file")"
    if [[ ! "$name" > "$BASELINE" ]]; then
      run -c "insert into public.schema_migrations (name) values ('$name')"
    fi
  done
fi

applied=0
for file in supabase/migrations/*.sql; do
  name="$(basename "$file")"
  if [ -z "$(run -At -c "select 1 from public.schema_migrations where name = '$name'")" ]; then
    echo "Applying $name"
    run --single-transaction -f "$file" -c "insert into public.schema_migrations (name) values ('$name')"
    applied=$((applied + 1))
  fi
done
echo "Applied $applied new file(s)."
