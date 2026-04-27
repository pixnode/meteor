/**
 * lazy-lp.js — Meteor Garden Bot
 * Modul B: Lazy LP + Deep Winter Engine
 *
 * Implementasi strategi eisbedog:
 *  - Lazy LP: single-sided SOL, range -74% s/d -80%
 *  - Deep Winter: compound semua fee ke SOL, suspend entry baru
 *
 * Cara kerja:
 *  1. Di-import oleh agent.js / prompt.js untuk inject context ke LLM
 *  2. Di-call oleh executor sebelum deploy_position untuk override parameter
 *  3. Bisa di-trigger manual via Telegram: /lazymode on|off
 */

import { getMacroZone, isDeepWinter } from "./macro-zone.js";
import { log } from "./logger.js";
import fs from "fs";

const USER_CONFIG_PATH = "./user-config.json";

// ─── Lazy LP Presets (eisbedog framework) ────────────────────────
export const LAZY_LP_PRESETS = {

  // Zona FEAR: range -74%, masih dual-sided tapi sangat lebar
  FEAR: {
    strategy:         "spot",
    bins_below:       148,   // ~74% coverage dengan bin step 50bps
    bins_above:       0,     // single-sided ke bawah
    single_sided:     true,
    range_pct:        74,
    auto_compound:    true,
    compound_to_sol:  false, // masih bisa ke USD
    description:      "Lazy LP Fear Zone — range -74%, single-sided SOL stacking",
  },

  // Zona DEEP_WINTER: range -80%, full SOL accumulation mode
  DEEP_WINTER: {
    strategy:         "spot",
    bins_below:       200,   // ~80% coverage
    bins_above:       0,
    single_sided:     true,
    range_pct:        80,
    auto_compound:    true,
    compound_to_sol:  true,  // WAJIB compound ke SOL, bukan USD
    suspend_new_entry: true, // pause entry pair baru
    description:      "Deep Winter — range -80%, SOL accumulation, compound ke SOL",
  },

  // Zona CAUTION: range -50%, masih dual-sided
  CAUTION: {
    strategy:         "bid_ask",
    bins_below:       100,
    bins_above:       20,
    single_sided:     false,
    range_pct:        50,
    auto_compound:    true,
    compound_to_sol:  false,
    description:      "Caution Zone — Bid-Ask lebar -50%, dual-sided",
  },
};

// ─── State file untuk tracking mode aktif ────────────────────────
const LAZY_STATE_FILE = "./lazy-lp-state.json";

function loadLazyState() {
  if (!fs.existsSync(LAZY_STATE_FILE)) {
    return { active: false, mode: null, activated_at: null, manual_override: false };
  }
  try {
    return JSON.parse(fs.readFileSync(LAZY_STATE_FILE, "utf8"));
  } catch {
    return { active: false, mode: null, activated_at: null, manual_override: false };
  }
}

function saveLazyState(state) {
  fs.writeFileSync(LAZY_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Evaluasi apakah Lazy LP mode harus aktif berdasarkan macro zone.
 * Dipanggil setiap siklus screening (setiap 30 menit).
 *
 * @returns {Object} { active, mode, preset, reason }
 */
export async function evaluateLazyMode() {
  const zone     = await getMacroZone();
  const state    = loadLazyState();

  // Manual override: user paksa on/off via Telegram
  if (state.manual_override) {
    log("lazy_lp", `Manual override aktif — mode: ${state.mode}`);
    return {
      active:  state.active,
      mode:    state.mode,
      preset:  state.mode ? LAZY_LP_PRESETS[state.mode] : null,
      reason:  "Manual override via Telegram",
      zone:    zone.zone,
    };
  }

  // Auto-detect berdasarkan zone
  let shouldActivate = false;
  let targetMode     = null;

  if (zone.zone === "DEEP_WINTER") {
    shouldActivate = true;
    targetMode     = "DEEP_WINTER";
  } else if (zone.zone === "FEAR") {
    shouldActivate = true;
    targetMode     = "FEAR";
  } else if (zone.zone === "CAUTION") {
    shouldActivate = true;
    targetMode     = "CAUTION";
  }

  // Update state jika berubah
  if (shouldActivate !== state.active || targetMode !== state.mode) {
    const newState = {
      active:         shouldActivate,
      mode:           targetMode,
      activated_at:   shouldActivate ? new Date().toISOString() : null,
      manual_override: false,
      zone_trigger:   zone.zone,
    };
    saveLazyState(newState);

    if (shouldActivate) {
      log("lazy_lp", `✅ Lazy LP AKTIF — mode: ${targetMode} | zone: ${zone.zone}`);
    } else {
      log("lazy_lp", `✅ Lazy LP NONAKTIF — zone: ${zone.zone} (Bull/Neutral)`);
    }
  }

  return {
    active:  shouldActivate,
    mode:    targetMode,
    preset:  targetMode ? LAZY_LP_PRESETS[targetMode] : null,
    reason:  `Auto dari macro zone: ${zone.zone}`,
    zone:    zone.zone,
    btc:     zone.btc_price,
    sol:     zone.sol_price,
  };
}

/**
 * Override parameter deploy_position berdasarkan Lazy LP mode aktif.
 * Dipanggil oleh executor.js sebelum deploy_position dieksekusi.
 *
 * @param {Object} deployArgs - args original dari LLM
 * @returns {Object} deployArgs yang sudah di-patch
 */
export async function patchDeployArgs(deployArgs) {
  const lazyState = await evaluateLazyMode();

  if (!lazyState.active || !lazyState.preset) {
    return deployArgs; // tidak ada perubahan
  }

  const preset = lazyState.preset;

  log("lazy_lp", `Patching deploy args dengan preset ${lazyState.mode}`);

  const patched = {
    ...deployArgs,
    strategy:   preset.strategy,
    bins_below: preset.bins_below,
    bins_above: preset.bins_above,
    // amount_x = 0 untuk single-sided SOL only
    ...(preset.single_sided && { amount_x: 0 }),
    _lazy_lp_override: {
      mode:        lazyState.mode,
      preset_desc: preset.description,
      original_bins_below: deployArgs.bins_below,
      original_strategy:   deployArgs.strategy,
    },
  };

  return patched;
}

/**
 * Manual toggle Lazy LP via Telegram command.
 * /lazymode on DEEP_WINTER | /lazymode off
 *
 * @param {boolean} active
 * @param {string|null} mode - "DEEP_WINTER" | "FEAR" | "CAUTION" | null
 */
export function setManualLazyMode(active, mode = null) {
  if (active && mode && !LAZY_LP_PRESETS[mode]) {
    return { error: `Mode tidak valid: ${mode}. Pilihan: ${Object.keys(LAZY_LP_PRESETS).join(", ")}` };
  }

  const state = {
    active,
    mode:            active ? mode : null,
    activated_at:    active ? new Date().toISOString() : null,
    manual_override: true,
  };

  saveLazyState(state);
  log("lazy_lp", `Manual override: active=${active}, mode=${mode}`);

  return {
    success:  true,
    active,
    mode,
    message:  active
      ? `✅ Lazy LP AKTIF (manual) — mode: ${mode}`
      : "⏹ Lazy LP NONAKTIF (manual)",
  };
}

/**
 * Get status Lazy LP saat ini — untuk Telegram /status command.
 */
export async function getLazyLpStatus() {
  const lazyState = await evaluateLazyMode();
  const zone      = await getMacroZone();

  return {
    lazy_active:     lazyState.active,
    mode:            lazyState.mode,
    zone:            zone.zone,
    zone_summary:    zone.summary,
    preset:          lazyState.preset,
    manual_override: loadLazyState().manual_override,
  };
}

/**
 * Cek apakah entry baru harus di-suspend.
 * Di Deep Winter, bot pause screening untuk pair baru.
 */
export async function shouldSuspendNewEntry() {
  const lazyState = await evaluateLazyMode();
  if (!lazyState.active || !lazyState.preset) return false;
  return lazyState.preset.suspend_new_entry === true;
}

/**
 * Apakah compound harus ke SOL (bukan USD)?
 */
export async function shouldCompoundToSol() {
  const lazyState = await evaluateLazyMode();
  if (!lazyState.active || !lazyState.preset) return false;
  return lazyState.preset.compound_to_sol === true;
}
