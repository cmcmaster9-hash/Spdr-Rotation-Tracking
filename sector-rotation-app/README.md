# Sector Rotation Tracker — cross-device setup

Three pieces: a Supabase table (storage), a GitHub Action (the thing that
actually fetches data on a timer, with no device needing to be open), and
`index.html` (the dashboard, hosted wherever you like — Netlify, GitHub
Pages, or just opened locally).

## 1. Supabase (storage)

1. Create a free project at [supabase.com](https://supabase.com) (no card required).
2. Open the SQL editor and run everything in `supabase-schema.sql`.
3. Go to **Settings → API** and note down three values:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`)
   - **anon public key** — safe to expose in the frontend, read-only by design
   - **service_role key** — keep secret, this is what lets the Action write

## 2. GitHub repo + Action (the auto-update)

1. Push this folder to a GitHub repo (public or private — either works with
   free Actions minutes for a job this small).
2. In the repo, go to **Settings → Secrets and variables → Actions** and add:
   - `TWELVE_DATA_API_KEY` — get a free key at [twelvedata.com](https://twelvedata.com/pricing), no card needed
   - `SUPABASE_URL` — the Project URL from step 1
   - `SUPABASE_SERVICE_KEY` — the service_role key from step 1 (**not** the anon key)
3. The workflow in `.github/workflows/fetch-sector-data.yml` runs automatically
   on weekdays at 21:30 UTC (after U.S. market close). You can also trigger it
   manually any time from the **Actions** tab → "Fetch sector data" → **Run workflow**.
4. Run it manually once now — it backfills ~90 days of history for all 12
   symbols on the very first run, so the dashboard has something to show
   immediately rather than waiting for tomorrow's scheduled run.

## 3. The dashboard (`index.html`)

- Open it (locally, or host it — Netlify, GitHub Pages, anywhere that serves
  a static file) and click **Data Source** in the top right. Paste in your
  Supabase Project URL and anon key, click **Save & Load**.
- That's it — it now reads shared data from Supabase, so any device that
  loads the page (with the same URL/key entered once) sees the same numbers.
- **To skip the setup step entirely on every device**, open `index.html`,
  find the two `HARDCODED_SUPABASE_URL` / `HARDCODED_SUPABASE_ANON_KEY`
  constants near the top of the `<script>` block, and paste your values in
  directly before you deploy. The Data Source panel then never needs to be
  touched again — the file just works wherever it's opened.

## How the pieces fit together

```
GitHub Actions (cron, weekdays 21:30 UTC)
        │  calls Twelve Data API (secret key, server-side only)
        ▼
Supabase "sector_daily" table  ← the shared source of truth
        │  read-only, anon key
        ▼
index.html  ← opened on any device, always shows the same synced data
```

Your Twelve Data key never touches the frontend — it lives only in GitHub's
encrypted secrets and is used once a day by the Action. Every device just
reads the results Supabase already has.

## Adjusting the schedule

Market close time shifts with DST, and the cron in the workflow file already
covers both (21:30 UTC works whether it's EDT or EST). If you want it to run
more than once a day — say, also near market open — add a second `cron` line
under `on: schedule:` in the workflow file.
