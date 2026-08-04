-- Sector Rotation Tracker — Supabase schema
-- Run this once in the Supabase SQL editor for your project.

create table if not exists sector_daily (
  symbol      text        not null,
  date        date        not null,
  close       numeric     not null,
  inserted_at timestamptz not null default now(),
  primary key (symbol, date)
);

-- Row Level Security: the table is readable by anyone with the public
-- anon key (safe — it's just daily ETF closing prices), but only
-- writable by the service_role key, which stays in GitHub Actions
-- secrets and never ships in the frontend.
alter table sector_daily enable row level security;

drop policy if exists "Public read access" on sector_daily;
create policy "Public read access"
  on sector_daily
  for select
  to anon
  using (true);

-- No insert/update/delete policy for anon is created on purpose —
-- the GitHub Action writes using the service_role key, which bypasses
-- RLS entirely, so anon truly can only ever read.

create index if not exists sector_daily_date_idx on sector_daily (date desc);
