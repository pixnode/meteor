/**
 * fibonacci.js — Meteor Garden Bot
 * Modul C: Fibonacci Anchoring
 *
 * Implementasi strategi EvilPanda:
 *  1. Fetch candle data dari Birdeye API
 *  2. Deteksi swing high + swing low via ZigZag algorithm
 *  3. Kalkulasi level Fibonacci retracement & extension
 *  4. Map level ke bin numbers dalam pool
 *  5. Validasi: apakah entry point selaras dengan Fibonacci level?
 *
 * Diintegrasikan ke screening.js sebagai filter tambahan.
 */

import { log } from "./logger.js";

const BIRDEYE_API   = "https://public-api.birdeye.so/defi";
const BIRDEYE_KEY   = process.env.BIRDEYE_API_KEY ?? "";  // opsional, ada rate limit gratis

// Level-level Fibonacci standar
const FIB_RETRACEMENT = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
const FIB_EXTENSION   = [1.0, 1.272, 1.414, 1.618, 2.0, 2.618];

// Tolerance: bin dianggap "di level Fibonacci" jika dalam ±2% dari level tersebut
const FIB_TOLERANCE_PCT = 0.02;

// Minimum swing size untuk ZigZag (5% = hanya swing yang signifikan)
const ZIGZAG_MIN_PCT = 0.05;

/**
 * Fetch candle data OHLCV dari Birdeye.
 * Fallback ke Jupiter price history jika Birdeye tidak tersedia.
 *
 * @param {string} tokenMint
 * @param {number} days - lookback period
 * @returns {Array} candles [{time, open, high, low, close, volume}]
 */
async function fetchCandles(tokenMint, days = 90) {
  const now      = Math.floor(Date.now() / 1000);
  const from     = now - days * 86400;
  const interval = "1D"; // daily candles untuk swing detection

  try {
    const url = `${BIRDEYE_API}/ohlcv?address=${tokenMint}&type=${interval}&time_from=${from}&time_to=${now}`;
    const headers = { "x-chain": "solana" };
    if (BIRDEYE_KEY) headers["X-API-KEY"] = BIRDEYE_KEY;

    const res  = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Birdeye OHLCV ${res.status}`);
    const data = await res.json();

    if (!data?.data?.items?.length) throw new Error("Birdeye: tidak ada candle data");
    return data.data.items;

  } catch (err) {
    log("fibonacci_warn", `Birdeye gagal (${err.message}), coba Jupiter fallback`);
    return fetchCandlesJupiterFallback(tokenMint, days);
  }
}

/**
 * Fallback: ambil harga harian dari Jupiter Price API history.
 * Format dikonversi ke format candle standar.
 */
async function fetchCandlesJupiterFallback(tokenMint, days = 90) {
  // Jupiter tidak punya API history publik gratis yang reliable,
  // kita gunakan DexScreener sebagai fallback kedua
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const data = await res.json();

  const pairs = data?.pairs ?? [];
  if (!pairs.length) throw new Error("Tidak ada pair data di DexScreener");

  // Ambil pair terbesar berdasarkan liquidity
  const pair = pairs.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];

  // DexScreener tidak punya OHLCV history, tapi kita bisa estimasi dari data tersedia
  // Return minimal data untuk tetap bisa berjalan
  const currentPrice = Number(pair.priceUsd ?? 0);
  const h24High      = currentPrice * (1 + Number(pair.priceChange?.h24 ?? 0) / 100);
  const h24Low       = currentPrice * (1 - Math.abs(Number(pair.priceChange?.h24 ?? 0)) / 100);

  // Buat pseudo-candles dari data 24h
  return [
    { time: Date.now() / 1000 - 86400, open: h24Low,  high: h24High, low: h24Low,  close: currentPrice, volume: 0 },
    { time: Date.now() / 1000,          open: currentPrice, high: currentPrice, low: currentPrice, close: currentPrice, volume: 0 },
  ];
}

/**
 * ZigZag algorithm: deteksi swing high dan swing low yang signifikan.
 * Hanya return swing dengan movement >= ZIGZAG_MIN_PCT dari titik sebelumnya.
 *
 * @param {Array} candles
 * @returns {Array} swings [{type: 'high'|'low', price, time, index}]
 */
function detectSwings(candles) {
  if (candles.length < 3) return [];

  const swings = [];
  let lastType  = null;
  let lastPrice = candles[0].close;

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    const isLocalHigh = curr.high >= prev.high && curr.high >= next.high;
    const isLocalLow  = curr.low  <= prev.low  && curr.low  <= next.low;

    if (isLocalHigh && lastType !== "high") {
      const changePct = Math.abs(curr.high - lastPrice) / lastPrice;
      if (changePct >= ZIGZAG_MIN_PCT) {
        swings.push({ type: "high", price: curr.high, time: curr.time, index: i });
        lastType  = "high";
        lastPrice = curr.high;
      }
    } else if (isLocalLow && lastType !== "low") {
      const changePct = Math.abs(curr.low - lastPrice) / lastPrice;
      if (changePct >= ZIGZAG_MIN_PCT) {
        swings.push({ type: "low", price: curr.low, time: curr.time, index: i });
        lastType  = "low";
        lastPrice = curr.low;
      }
    }
  }

  return swings;
}

/**
 * Ambil swing high tertinggi dan swing low terendah
 * dari N swing terakhir yang paling relevan.
 */
function getKeySwings(swings, lookback = 10) {
  const recent = swings.slice(-lookback);
  const highs   = recent.filter(s => s.type === "high").map(s => s.price);
  const lows    = recent.filter(s => s.type === "low").map(s => s.price);

  if (!highs.length || !lows.length) return null;

  return {
    swingHigh: Math.max(...highs),
    swingLow:  Math.min(...lows),
  };
}

/**
 * Kalkulasi semua level Fibonacci dari swing high dan swing low.
 *
 * @param {number} swingHigh
 * @param {number} swingLow
 * @returns {Object} { retracement: [...], extension: [...] }
 */
export function calculateFibLevels(swingHigh, swingLow) {
  const range = swingHigh - swingLow;

  const retracement = FIB_RETRACEMENT.map(ratio => ({
    ratio,
    label:  `${(ratio * 100).toFixed(1)}%`,
    price:  swingHigh - (range * ratio),
    type:   "retracement",
  }));

  const extension = FIB_EXTENSION.map(ratio => ({
    ratio,
    label:  `${(ratio * 100).toFixed(1)}%`,
    price:  swingLow + (range * ratio),
    type:   "extension",
  }));

  return {
    swing_high: swingHigh,
    swing_low:  swingLow,
    range,
    retracement,
    extension,
    all: [...retracement, ...extension].sort((a, b) => a.price - b.price),
  };
}

/**
 * Cari level Fibonacci terdekat dengan harga saat ini.
 *
 * @param {number} currentPrice
 * @param {Object} fibLevels - output dari calculateFibLevels
 * @returns {Object|null} level terdekat dengan distance_pct
 */
export function findNearestFibLevel(currentPrice, fibLevels) {
  if (!fibLevels?.all?.length) return null;

  let nearest    = null;
  let minDistPct = Infinity;

  for (const level of fibLevels.all) {
    const distPct = Math.abs(currentPrice - level.price) / currentPrice;
    if (distPct < minDistPct) {
      minDistPct = distPct;
      nearest    = { ...level, distance_pct: distPct };
    }
  }

  return nearest;
}

/**
 * Validasi: apakah harga saat ini berada di level Fibonacci yang signifikan?
 * Ini adalah gate untuk entry — kalau harga jauh dari level Fib, entry ditolak.
 *
 * @param {number} currentPrice
 * @param {Object} fibLevels
 * @returns {Object} { valid, nearest_level, distance_pct, message }
 */
export function validateFibEntry(currentPrice, fibLevels) {
  const nearest = findNearestFibLevel(currentPrice, fibLevels);

  if (!nearest) {
    return {
      valid:   false,
      message: "Fibonacci levels tidak bisa dikalkulasi — tidak cukup data",
    };
  }

  const isValid = nearest.distance_pct <= FIB_TOLERANCE_PCT;

  return {
    valid:          isValid,
    nearest_level:  nearest,
    distance_pct:   (nearest.distance_pct * 100).toFixed(2) + "%",
    tolerance_pct:  (FIB_TOLERANCE_PCT * 100).toFixed(0) + "%",
    message: isValid
      ? `✅ Harga dekat level Fib ${nearest.label} (${nearest.type}) — entry valid`
      : `❌ Harga terlalu jauh dari level Fibonacci terdekat (${nearest.label}, jarak ${(nearest.distance_pct * 100).toFixed(2)}%) — entry ditolak`,
  };
}

/**
 * Kalkulasi bin boundaries yang optimal berdasarkan Fibonacci levels.
 * Bin bawah ditempatkan di level Fib support terdekat.
 *
 * @param {number} currentPrice
 * @param {Object} fibLevels
 * @param {number} binStep - dalam basis points (e.g., 100 = 1%)
 * @returns {Object} { lower_price, upper_price, bins_below, bins_above }
 */
export function fibBinBoundaries(currentPrice, fibLevels, binStep = 100) {
  const binStepDecimal = binStep / 10_000;

  // Support: Fibonacci level di bawah harga saat ini
  const supports = fibLevels.all
    .filter(l => l.price < currentPrice)
    .sort((a, b) => b.price - a.price); // sort descending, ambil yang terdekat

  // Resistance: Fibonacci level di atas harga saat ini
  const resistances = fibLevels.all
    .filter(l => l.price > currentPrice)
    .sort((a, b) => a.price - b.price); // sort ascending, ambil yang terdekat

  const supportLevel    = supports[0]?.price ?? currentPrice * 0.85;
  const resistanceLevel = resistances[0]?.price ?? currentPrice * 1.15;

  // Kalkulasi berapa bins yang dibutuhkan
  const binsBelow = Math.ceil(
    Math.log(currentPrice / supportLevel) / Math.log(1 + binStepDecimal)
  );
  const binsAbove = Math.ceil(
    Math.log(resistanceLevel / currentPrice) / Math.log(1 + binStepDecimal)
  );

  return {
    lower_price:  supportLevel,
    upper_price:  resistanceLevel,
    bins_below:   Math.max(5, Math.min(200, binsBelow)),
    bins_above:   Math.max(5, Math.min(100, binsAbove)),
    support_fib:  supports[0] ?? null,
    resistance_fib: resistances[0] ?? null,
  };
}

/**
 * Main function: jalankan full Fibonacci analysis untuk sebuah token.
 *
 * @param {string} tokenMint
 * @param {number} currentPrice
 * @param {number} binStep
 * @returns {Object} full analysis result
 */
export async function analyzeFibonacci(tokenMint, currentPrice, binStep = 100) {
  try {
    log("fibonacci", `Analyzing ${tokenMint.slice(0, 8)}... @ $${currentPrice}`);

    // 1. Fetch candle data
    const candles = await fetchCandles(tokenMint, 90);
    if (candles.length < 5) {
      return {
        valid:   false,
        error:   "Data candle tidak cukup (minimum 5 candle)",
        message: "❌ Fibonacci: data tidak cukup untuk analisa",
      };
    }

    // 2. Deteksi swing
    const swings    = detectSwings(candles);
    const keySwings = getKeySwings(swings);

    if (!keySwings) {
      return {
        valid:   false,
        error:   "Tidak bisa deteksi swing high/low yang signifikan",
        message: "❌ Fibonacci: tidak ada swing signifikan terdeteksi",
      };
    }

    // 3. Kalkulasi levels
    const fibLevels = calculateFibLevels(keySwings.swingHigh, keySwings.swingLow);

    // 4. Validasi entry
    const entryValidation = validateFibEntry(currentPrice, fibLevels);

    // 5. Kalkulasi bin boundaries optimal
    const binBounds = fibBinBoundaries(currentPrice, fibLevels, binStep);

    const result = {
      valid:             entryValidation.valid,
      message:           entryValidation.message,
      swing_high:        keySwings.swingHigh,
      swing_low:         keySwings.swingLow,
      current_price:     currentPrice,
      nearest_fib:       entryValidation.nearest_level,
      fib_levels:        fibLevels.all.slice(0, 10), // top 10 levels
      bin_recommendation: binBounds,
      candle_count:      candles.length,
      swing_count:       swings.length,
    };

    log("fibonacci", `${tokenMint.slice(0, 8)}: ${result.message}`);
    return result;

  } catch (err) {
    log("fibonacci_error", `${tokenMint.slice(0, 8)}: ${err.message}`);
    return {
      valid:   false,
      error:   err.message,
      message: `❌ Fibonacci error: ${err.message}`,
    };
  }
}
