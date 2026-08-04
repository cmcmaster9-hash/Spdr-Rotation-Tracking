// Fetches daily closes for the 11 SPDR sector ETFs + SPY from Twelve Data
// and upserts them into the Supabase `sector_daily` table.
//
// Required environment variables (set as GitHub Actions secrets):
//   TWELVE_DATA_API_KEY
//   SUPABASE_URL           e.g. https://xxxxx.supabase.co
//   SUPABASE_SERVICE_KEY   the service_role key (NOT the anon key)
//
// Run with: node scripts/fetch-sector-data.mjs

const SYMBOLS = ['XLC','XLY','XLP','XLE','XLF','XLV','XLI','XLB','XLRE','XLK','XLU','SPY'];
const OUTPUT_SIZE = 90; // days of history to keep synced on every run

const { TWELVE_DATA_API_KEY, SUPABASE_SERVICE_KEY } = process.env;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');

if (!TWELVE_DATA_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required env vars: TWELVE_DATA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

async function fetchSymbol(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${OUTPUT_SIZE}&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status === 'error' || !json.values) {
    throw new Error(`Twelve Data error for ${symbol}: ${json.message || 'unknown error'}`);
  }
  return json.values.map(v => ({
    symbol,
    date: v.datetime,
    close: parseFloat(v.close),
  }));
}

async function upsertRows(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sector_daily?on_conflict=symbol,date`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed (${res.status}): ${text}`);
  }
}

async function main() {
  console.log(`Fetching ${SYMBOLS.length} symbols from Twelve Data...`);
  let allRows = [];
  for (const symbol of SYMBOLS) {
    try {
      const rows = await fetchSymbol(symbol);
      console.log(`  ${symbol}: ${rows.length} rows`);
      allRows = allRows.concat(rows);
    } catch (err) {
      console.error(`  ${symbol} failed: ${err.message}`);
    }
    // Free-tier Twelve Data is capped at 8 requests/minute — space calls
    // out enough to stay under that (~8s gives a safety margin).
    await new Promise(r => setTimeout(r, 8000));
  }

  if (allRows.length === 0) {
    console.error('No data fetched from any symbol — aborting without writing to Supabase.');
    process.exit(1);
  }

  console.log(`Upserting ${allRows.length} rows into Supabase...`);
  // Supabase/PostgREST handles large batches fine, but chunk defensively.
  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    await upsertRows(allRows.slice(i, i + CHUNK));
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
