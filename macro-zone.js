/**
 * macro-zone.js — Meteor Garden Bot
 * Modul A: Macro Zone Detection
 *
 * Fetch harga BTC + SOL secara real-time via Jupiter Price API,
 * lalu return label zone: BULL | NEUTRAL | CAUTION | FEAR | DEEP_WINTER
 *
 * Zone ini digunakan oleh:
 *  - strategy-selector.js  → pilih distribusi optimal
 *  - lazy-lp.js            → aktifkan Deep Winter mode
 *  - fibonacci.js          → adjust threshold confidence
 */

import { log } from "./logger.js";

const JUPITER_PRICE_API = "https://price.jup.ag/v6/price";
const BTC_MINT  = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"; // Wormhole BTC on Solana
const SOL_MINT  = "So11111111111111111111111111111111111111112";

// ─── Zone thresholds (eisbedog Fear Zone framework) ─────────────
const ZONES = [
  {
    label:       "DEEP_WINTER",
    btcMin:      0,
    btcMax:      55_000,
    solMin:      0,
    solMax:      80,
    strategy:    "single_sided_spot",
    rangeExtPct: 80,          // extend range -80% dari harga
    objective:   "SOL accumulation — compound semua fee ke SOL, jangan convert ke USD",
    color:       "🔵",
  },
  {
    label:       "FEAR",
    btcMin:      55_000,
    btcMax:      70_000,
    solMin:      80,
    solMax:      120,
    strategy:    "bid_ask",
    rangeExtPct: 74,
    objective:   "Survive + akumulasi — range lebar, minimize rebalancing",
    color:       "🟣",
  },
  {
    label:       "CAUTION",
    btcMin:      70_000,
    btcMax:      90_000,
    solMin:      120,
    solMax:      200,
    strategy:    "spot",
    rangeExtPct: 50,
    objective:   "Balance fee vs IL — Spot standard 40-60 bins",
    color:       "🟡",
  },
  {
    label:       "NEUTRAL",
    btcMin:      90_000,
    btcMax:      110_000,
    solMin:      200,
    solMax:      350,
    strategy:    "spot",
    rangeExtPct: 30,
    objective:   "Standard operation — optimasi fee capture",
    color:       "🟢",
  },
  {
    label:       "BULL",
    btcMin:      110_000,
    btcMax:      Infinity,
    solMin:      350,
    solMax:      Infinity,
    strategy:    "curve",
    rangeExtPct: 15,
    objective:   "Maksimalkan USD fee — Curve terpusat 15-20 bins",
    color:       "🚀",
  },
];

// ─── In-memory cache (TTL 5 menit) ──────────────────────────────
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch harga BTC dan SOL dari Jupiter Price API.
 * Return { btc, sol } dalam USD.
 */
async function fetchPrices() {
  const url = `${JUPITER_PRICE_API}?ids=${BTC_MINT},${SOL_MINT}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Jupiter Price API ${res.status}`);
  const data = await res.json();

  const btc = Number(data?.data?.[BTC_MINT]?.price ?? 0);
  const sol = Number(data?.data?.[SOL_MINT]?.price ?? 0);

  if (!btc || !sol) throw new Error("Harga BTC/SOL tidak tersedia dari Jupiter");
  return { btc, sol };
}

/**
 * Tentukan zone berdasarkan harga BTC dan SOL.
 * Logic: ambil zone yang paling konservatif dari keduanya
 * (yaitu zone dengan indeks terendah = paling bearish).
 */
function classifyZone(btcPrice, solPrice) {
  // Cari zone berdasarkan BTC
  const btcZone = ZONES.find(z => btcPrice >= z.btcMin && btcPrice < z.btcMax)
    ?? ZONES[0]; // fallback DEEP_WINTER

  // Cari zone berdasarkan SOL
  const solZone = ZONES.find(z => solPrice >= z.solMin && solPrice < z.solMax)
    ?? ZONES[0];

  // Ambil yang lebih konservatif (index lebih kecil = lebih bearish)
  const btcIdx = ZONES.indexOf(btcZone);
  const solIdx = ZONES.indexOf(solZone);
  return ZONES[Math.min(btcIdx, solIdx)];
}

/**
 * Main export: getMarcoZone()
 * Return object lengkap dengan harga + zone + rekomendasi strategi.
 *
 * @param {boolean} forceRefresh - bypass cache
 */
export async function getMacroZone(forceRefresh = false) {
  const now = Date.now();

  // Return cache jika masih fresh
  if (!forceRefresh && _cache && (now - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  try {
    const { btc, sol } = await fetchPrices();
    const zone = classifyZone(btc, sol);

    const result = {
      btc_price:    btc,
      sol_price:    sol,
      zone:         zone.label,
      color:        zone.color,
      strategy:     zone.strategy,
      range_ext_pct: zone.rangeExtPct,
      objective:    zone.objective,
      deep_winter:  zone.label === "DEEP_WINTER",
      timestamp:    new Date().toISOString(),
      summary: `${zone.color} ${zone.label} | BTC $${btc.toLocaleString()} | SOL $${sol.toFixed(2)} | Strategi: ${zone.strategy} | Range ext: -${zone.rangeExtPct}%`,
    };

    _cache   = result;
    _cacheTs = now;

    log("macro_zone", result.summary);
    return result;

  } catch (err) {
    log("macro_zone_error", `Gagal fetch harga: ${err.message}`);

    // Jika cache lama masih ada, return itu dengan flag stale
    if (_cache) {
      return { ..._cache, stale: true, stale_reason: err.message };
    }

    // Fallback paling aman: CAUTION zone
    return {
      btc_price:    null,
      sol_price:    null,
      zone:         "CAUTION",
      color:        "🟡",
      strategy:     "spot",
      range_ext_pct: 50,
      objective:    "Fallback CAUTION — harga tidak bisa difetch",
      deep_winter:  false,
      timestamp:    new Date().toISOString(),
      error:        err.message,
      summary:      "🟡 CAUTION (fallback) | Tidak bisa fetch harga BTC/SOL",
    };
  }
}

/**
 * Helper: apakah saat ini Deep Winter?
 */
export async function isDeepWinter() {
  const zone = await getMacroZone();
  return zone.deep_winter === true;
}

/**
 * Helper: return rekomendasi range extension percentage
 * berdasarkan macro zone saat ini.
 */
export async function getRecommendedRangeExt() {
  const zone = await getMacroZone();
  return zone.range_ext_pct;
}
