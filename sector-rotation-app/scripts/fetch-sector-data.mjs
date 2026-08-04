// Fetches daily closes for the 11 SPDR sector ETFs + SPY from Twelve Data
// and upserts them into the Supabase `sector_daily` table.
//
// Required environment variables (set as GitHub Actions secrets):
//   TWELVE_DATA_API_KEY
//   SUPABASE_URL           e.g. https://xxxxx.supabase.co
//   SUPABASE_SERVICE_KEY   the service_role key (NOT the anon key)
//
// Run with: node scripts/fetch-sector-data.mjs

import * as XLSX from 'xlsx';

const SYMBOLS = ['XLC','XLY','XLP','XLE','XLF','XLV','XLI','XLB','XLRE','XLK','XLU','SPY'];
const SECTOR_ONLY_SYMBOLS = SYMBOLS.filter(s => s !== 'SPY'); // holdings only make sense for the sector funds
const OUTPUT_SIZE = 500; // ~2 years of trading days — cheap on credits (still 1 call per symbol), gives room for seasonality
const MAX_HOLDINGS = 15; // top N constituents to store per sector

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
  return json.values
    .map(v => ({ symbol, date: v.datetime, close: parseFloat(v.close) }))
    .sort((a, b) => b.date.localeCompare(a.date)); // newest first — quadrant math below depends on this order
}

// Pulls top holdings for a sector ETF from State Street's own public daily
// holdings file — free, no key, no plan gate (unlike Twelve Data's
// composition endpoint, which turned out to require an Ultra/Enterprise
// plan). This isn't officially documented as an API, so it's parsed
// defensively: it scans for the header row by looking for "Name" and
// "Weight" columns rather than assuming a fixed row/column position, and
// logs what it actually found if that scan comes up empty — so a layout
// change on SSGA's end shows up clearly in the Action log instead of
// silently returning nothing.
async function fetchComposition(symbol) {
  const url = `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${symbol.toLowerCase()}.xlsx`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SSGA holdings file error for ${symbol}: HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  // Find the header row: the first row containing both a "name"-ish and
  // "weight"-ish column label.
  let headerRowIdx = -1, nameCol = -1, weightCol = -1, tickerCol = -1;
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const row = grid[i] || [];
    const norm = row.map(c => (c == null ? '' : String(c).trim().toLowerCase()));
    const nIdx = norm.findIndex(c => c === 'name');
    const wIdx = norm.findIndex(c => c.includes('weight'));
    if (nIdx !== -1 && wIdx !== -1) {
      headerRowIdx = i; nameCol = nIdx; weightCol = wIdx;
      tickerCol = norm.findIndex(c => c === 'ticker' || c === 'identifier');
      break;
    }
  }

  if (headerRowIdx === -1) {
    console.warn(`  ${symbol}: couldn't find a Name/Weight header row in the SSGA file. First few rows: ${JSON.stringify(grid.slice(0,5))}`);
    return [];
  }

  const holdings = [];
  for (let i = headerRowIdx + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    const name = row[nameCol];
    const weightRaw = row[weightCol];
    if (!name || weightRaw == null || weightRaw === '') continue; // end of table / blank trailer rows
    const weight = parseFloat(weightRaw);
    if (isNaN(weight)) continue;
    holdings.push({
      symbol,
      holding_symbol: tickerCol !== -1 ? (row[tickerCol] || null) : null,
      holding_name: String(name).trim(),
      weight,
    });
  }

  if (holdings.length === 0) {
    console.warn(`  ${symbol}: header row found but no valid holding rows parsed underneath it.`);
    return [];
  }

  holdings.sort((a, b) => b.weight - a.weight);
  return holdings.slice(0, MAX_HOLDINGS).map((h, i) => ({ ...h, rank: i + 1 }));
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

async function replaceHoldings(symbol, rows) {
  // Delete this symbol's existing holdings first, so a shrinking list
  // (e.g. fund now has fewer top constituents) doesn't leave stale rows.
  const delRes = await fetch(`${SUPABASE_URL}/rest/v1/sector_holdings?symbol=eq.${encodeURIComponent(symbol)}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
  });
  if (!delRes.ok) {
    const text = await delRes.text();
    throw new Error(`Supabase holdings delete failed for ${symbol} (${delRes.status}): ${text}`);
  }

  if (rows.length === 0) return; // nothing to insert (endpoint gated or empty)

  const insRes = await fetch(`${SUPABASE_URL}/rest/v1/sector_holdings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!insRes.ok) {
    const text = await insRes.text();
    throw new Error(`Supabase holdings insert failed for ${symbol} (${insRes.status}): ${text}`);
  }
}

// ---------- Rotation-map quadrant classification (mirrors the frontend's math) ----------
// closes arrays are sorted newest-first, same shape as what fetchSymbol returns.
function pctChange(closes, aIdx, bIdx) {
  if (closes.length <= Math.max(aIdx, bIdx)) return null;
  const a = closes[aIdx].close, b = closes[bIdx].close;
  if (!a || !b) return null;
  return (a - b) / b;
}
function relStrength(sectorCloses, benchCloses, t) {
  const sr = pctChange(sectorCloses, t, t + 20);
  const br = pctChange(benchCloses, t, t + 20);
  if (sr === null || br === null) return null;
  return sr - br;
}
function classifyQuadrant(sectorCloses, benchCloses) {
  const rs = relStrength(sectorCloses, benchCloses, 0);
  const rsPrev = relStrength(sectorCloses, benchCloses, 5);
  if (rs === null || rsPrev === null) return null;
  const momentum = rs - rsPrev;
  if (rs >= 0 && momentum >= 0) return 'leading';
  if (rs < 0 && momentum >= 0) return 'improving';
  if (rs < 0 && momentum < 0) return 'lagging';
  return 'weakening';
}

async function fetchQuadrantStates() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sector_quadrant_state?select=symbol,quadrant`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`Fetching quadrant state failed (${res.status}): ${await res.text()}`);
  const rows = await res.json();
  const map = {};
  rows.forEach(r => { map[r.symbol] = r.quadrant; });
  return map;
}

async function upsertQuadrantState(symbol, quadrant) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sector_quadrant_state?on_conflict=symbol`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ symbol, quadrant, updated_at: new Date().toISOString() }]),
  });
  if (!res.ok) throw new Error(`Quadrant state upsert failed for ${symbol} (${res.status}): ${await res.text()}`);
}

async function insertSignal(symbol, date, fromQuadrant, toQuadrant) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sector_signals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify([{ symbol, date, from_quadrant: fromQuadrant, to_quadrant: toQuadrant }]),
  });
  if (!res.ok) throw new Error(`Signal insert failed for ${symbol} (${res.status}): ${await res.text()}`);
}

async function main() {
  console.log(`Fetching ${SYMBOLS.length} symbols from Twelve Data...`);
  let allRows = [];
  const pricesBySymbol = {};
  for (const symbol of SYMBOLS) {
    try {
      const rows = await fetchSymbol(symbol);
      console.log(`  ${symbol}: ${rows.length} rows`);
      allRows = allRows.concat(rows);
      // fetchSymbol's underlying API already returns newest-first
      pricesBySymbol[symbol] = rows;
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

  console.log('Checking for rotation-map quadrant crossings...');
  try {
    const benchCloses = pricesBySymbol['SPY'];
    if (!benchCloses) {
      console.warn('  SPY data unavailable this run — skipping quadrant check.');
    } else {
      const priorStates = await fetchQuadrantStates();
      const todayStr = new Date().toISOString().slice(0, 10);
      for (const symbol of SECTOR_ONLY_SYMBOLS) {
        const closes = pricesBySymbol[symbol];
        if (!closes) continue;
        const quadrant = classifyQuadrant(closes, benchCloses);
        if (!quadrant) continue;
        const prior = priorStates[symbol];
        if (prior && prior !== quadrant) {
          console.log(`  ${symbol}: ${prior} → ${quadrant}`);
          await insertSignal(symbol, todayStr, prior, quadrant);
        }
        await upsertQuadrantState(symbol, quadrant);
      }
    }
  } catch (err) {
    // Never let signal-tracking issues break the core price sync above.
    console.error(`  Quadrant tracking failed: ${err.message}`);
  }

  console.log(`Fetching holdings for ${SECTOR_ONLY_SYMBOLS.length} sector ETFs from SSGA...`);
  let holdingsOk = 0, holdingsFailed = 0;
  for (const symbol of SECTOR_ONLY_SYMBOLS) {
    try {
      const rows = await fetchComposition(symbol);
      await replaceHoldings(symbol, rows);
      console.log(`  ${symbol}: ${rows.length} holdings saved`);
      if (rows.length > 0) holdingsOk++; else holdingsFailed++;
    } catch (err) {
      console.error(`  ${symbol} holdings failed: ${err.message}`);
      holdingsFailed++;
    }
    // Polite pacing for SSGA's server — this isn't subject to Twelve Data's
    // 8 req/min limit since it's a separate host, but no need to hammer it.
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`Holdings sync: ${holdingsOk} succeeded, ${holdingsFailed} empty/failed.`);
  if (holdingsOk === 0) {
    console.warn('No holdings data was saved for any sector — SSGA may have changed their file format or URL pattern. Check the warnings above for details. Price data above was still synced fine.');
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
