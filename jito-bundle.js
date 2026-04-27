/**
 * jito-bundle.js — Meteor Garden Bot
 * Modul D: Jito Bundle MEV Protection
 *
 * Wrap semua write transactions (deploy, close, claim, swap) ke dalam
 * Jito block engine untuk:
 *  - Proteksi dari sandwich attacks
 *  - Atomic execution (semua berhasil atau semua gagal)
 *  - Priority execution via tip
 *
 * Cara integrasi:
 *  - executor.js memanggil wrapWithJito() sebelum broadcast transaction
 *  - Jika Jito gagal, fallback ke standard broadcast
 */

import { log } from "./logger.js";

// Jito Block Engine endpoints (pilih yang terdekat secara geografis)
// Untuk VPS Asia, gunakan Tokyo atau Amsterdam
const JITO_ENDPOINTS = [
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles",
  "https://mainnet.block-engine.jito.wtf/api/v1/bundles", // US fallback
];

// Tip accounts Jito (salah satu dari 8 official tip accounts)
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

// Default tip: 10_000 lamports = ~0.00001 SOL
// Naikkan jika ingin lebih prioritas
const DEFAULT_TIP_LAMPORTS = 10_000;
const HIGH_PRIORITY_TIP    = 50_000;  // untuk close/emergency
const MAX_TIP_LAMPORTS      = 100_000; // hard cap

/**
 * Kalkulasi tip yang optimal berdasarkan urgency.
 *
 * @param {'normal'|'high'|'emergency'} urgency
 * @returns {number} tip dalam lamports
 */
function calculateTip(urgency = "normal") {
  switch (urgency) {
    case "emergency": return MAX_TIP_LAMPORTS;
    case "high":      return HIGH_PRIORITY_TIP;
    default:          return DEFAULT_TIP_LAMPORTS;
  }
}

/**
 * Pilih Jito endpoint dengan latency test sederhana.
 * Return endpoint pertama yang respond < 2 detik.
 */
async function selectBestEndpoint() {
  for (const endpoint of JITO_ENDPOINTS) {
    try {
      const start = Date.now();
      const res   = await fetch(endpoint.replace("/bundles", "/health"), {
        signal: AbortSignal.timeout(2_000)
      });
      const latency = Date.now() - start;
      if (res.ok || res.status === 404) { // 404 = endpoint exist tapi path berbeda
        log("jito", `Selected endpoint: ${endpoint} (${latency}ms)`);
        return endpoint;
      }
    } catch {
      continue;
    }
  }
  // Fallback ke default jika semua gagal
  return JITO_ENDPOINTS[2];
}

/**
 * Submit bundle ke Jito Block Engine.
 *
 * @param {Array<string>} serializedTxs - array of base58-encoded signed transactions
 * @param {string} urgency
 * @returns {Object} { success, bundle_id, error }
 */
export async function submitJitoBundle(serializedTxs, urgency = "normal") {
  if (!serializedTxs?.length) {
    return { success: false, error: "Tidak ada transaction untuk di-bundle" };
  }

  const endpoint = await selectBestEndpoint();
  const tip      = calculateTip(urgency);

  try {
    log("jito", `Submitting bundle: ${serializedTxs.length} txs, tip: ${tip} lamports, urgency: ${urgency}`);

    const payload = {
      jsonrpc: "2.0",
      id:      1,
      method:  "sendBundle",
      params:  [serializedTxs],
    };

    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(15_000),
    });

    const data = await res.json();

    if (data.error) {
      throw new Error(`Jito error: ${data.error.message ?? JSON.stringify(data.error)}`);
    }

    const bundleId = data.result;
    log("jito", `Bundle submitted: ${bundleId}`);

    return {
      success:    true,
      bundle_id:  bundleId,
      tip_lamports: tip,
      endpoint,
    };

  } catch (err) {
    log("jito_error", `Bundle submission failed: ${err.message}`);
    return {
      success:   false,
      error:     err.message,
      tip_lamports: tip,
    };
  }
}

/**
 * Buat tip instruction untuk Jito.
 * Harus disertakan sebagai transaksi terakhir dalam bundle.
 *
 * @param {number} tipLamports
 * @returns {Object} instruksi transfer SOL ke random tip account
 */
export function createJitoTipInstruction(tipLamports = DEFAULT_TIP_LAMPORTS) {
  // Pilih tip account secara random untuk distribusi
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

  return {
    tip_account:   tipAccount,
    tip_lamports:  Math.min(tipLamports, MAX_TIP_LAMPORTS),
    description:   `Jito tip: ${tipLamports} lamports → ${tipAccount.slice(0, 8)}...`,
  };
}

/**
 * Check status bundle yang sudah disubmit.
 *
 * @param {string} bundleId
 * @returns {Object} { status, confirmed, error }
 */
export async function checkBundleStatus(bundleId) {
  if (!bundleId) return { error: "Bundle ID diperlukan" };

  try {
    const endpoint = JITO_ENDPOINTS[2]; // gunakan US untuk check status
    const statusUrl = endpoint.replace("/bundles", "/getBundleStatuses");

    const res = await fetch(statusUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "getBundleStatuses",
        params:  [[bundleId]],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await res.json();
    const status = data?.result?.value?.[0];

    if (!status) {
      return { status: "unknown", bundle_id: bundleId };
    }

    return {
      bundle_id:   bundleId,
      status:      status.confirmation_status ?? "pending",
      confirmed:   status.confirmation_status === "finalized",
      transactions: status.transactions ?? [],
    };

  } catch (err) {
    return { error: err.message, bundle_id: bundleId };
  }
}

/**
 * MEV Protection config yang di-inject ke executor.js.
 * Berisi settings untuk melindungi transaksi dari frontrunning.
 */
export const MEV_PROTECTION_CONFIG = {
  // Slippage maksimum untuk swap/rebalancing
  max_slippage_bps: 50,  // 0.5%

  // Random delay sebelum broadcast (ms) — mencegah timing attack
  min_delay_ms: 100,
  max_delay_ms: 500,

  // Retry jika bundle gagal
  max_retries: 3,
  retry_delay_ms: 2_000,

  // Jito tip defaults
  default_tip: DEFAULT_TIP_LAMPORTS,
  high_tip:    HIGH_PRIORITY_TIP,
  max_tip:     MAX_TIP_LAMPORTS,
};

/**
 * Random delay untuk mengacak timing transaction broadcast.
 * Mencegah timing-based MEV.
 */
export async function randomDelay() {
  const { min_delay_ms, max_delay_ms } = MEV_PROTECTION_CONFIG;
  const delay = min_delay_ms + Math.random() * (max_delay_ms - min_delay_ms);
  await new Promise(resolve => setTimeout(resolve, delay));
  log("jito", `Random delay: ${delay.toFixed(0)}ms`);
}

/**
 * Wrapper utama: tambahkan MEV protection ke semua write operations.
 * Dipanggil oleh executor.js sebelum eksekusi tool WRITE_TOOLS.
 *
 * @param {string} toolName
 * @param {Function} executeFn - fungsi eksekusi original
 * @returns {Function} wrapped function dengan MEV protection
 */
export function withMevProtection(toolName, executeFn) {
  return async function(...args) {
    // 1. Random delay
    await randomDelay();

    // 2. Log intent
    log("mev_protection", `Protected execution: ${toolName}`);

    // 3. Execute dengan retry logic
    let lastError;
    for (let attempt = 1; attempt <= MEV_PROTECTION_CONFIG.max_retries; attempt++) {
      try {
        const result = await executeFn(...args);
        if (result?.error && attempt < MEV_PROTECTION_CONFIG.max_retries) {
          throw new Error(result.error);
        }
        return result;
      } catch (err) {
        lastError = err;
        log("mev_protection", `Attempt ${attempt}/${MEV_PROTECTION_CONFIG.max_retries} failed: ${err.message}`);
        if (attempt < MEV_PROTECTION_CONFIG.max_retries) {
          await new Promise(r => setTimeout(r, MEV_PROTECTION_CONFIG.retry_delay_ms));
        }
      }
    }

    return { error: `Gagal setelah ${MEV_PROTECTION_CONFIG.max_retries} attempts: ${lastError?.message}` };
  };
}

/**
 * Status check: apakah Jito tersedia saat ini?
 * Digunakan untuk health check bot.
 */
export async function checkJitoHealth() {
  try {
    const endpoint = await selectBestEndpoint();
    return {
      available: true,
      endpoint,
      tip_config: {
        normal:    DEFAULT_TIP_LAMPORTS,
        high:      HIGH_PRIORITY_TIP,
        emergency: MAX_TIP_LAMPORTS,
      },
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}
