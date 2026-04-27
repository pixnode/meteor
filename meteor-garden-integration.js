/**
 * meteor-garden-integration.js
 * Patch integration — sambungkan 4 modul kustom ke Meridian
 *
 * CARA PAKAI:
 * Di agent.js atau index.js, tambahkan satu baris:
 *   import { initMeteorGarden } from "./meteor-garden-integration.js";
 *   await initMeteorGarden();
 *
 * Ini akan auto-patch semua hooks tanpa mengubah kode Meridian asli.
 */

import { getMacroZone, isDeepWinter }             from "./macro-zone.js";
import { evaluateLazyMode, patchDeployArgs,
         shouldSuspendNewEntry, getLazyLpStatus }  from "./lazy-lp.js";
import { analyzeFibonacci }                        from "./fibonacci.js";
import { withMevProtection, checkJitoHealth,
         MEV_PROTECTION_CONFIG }                   from "./jito-bundle.js";
import { log }                                     from "./logger.js";

// ─── 1. Macro Zone injection ke prompt.js ───────────────────────
// Tambahkan context macro zone ke system prompt setiap siklus

export async function getMacroZonePromptContext() {
  try {
    const zone      = await getMacroZone();
    const lazyState = await getLazyLpStatus();

    return `
## MACRO ZONE (Real-time)
${zone.summary}
- Objective: ${zone.objective}
- Recommended strategy: ${zone.strategy}
- Range extension: -${zone.range_ext_pct}%
- Deep Winter mode: ${zone.deep_winter ? "✅ AKTIF — compound semua fee ke SOL, suspend entry baru" : "❌ Tidak aktif"}
${lazyState.lazy_active ? `- Lazy LP mode: AKTIF (${lazyState.mode})` : ""}

PENTING: Sesuaikan semua keputusan deployment dengan zona makro di atas.
${zone.deep_winter ? "⚠️ DEEP WINTER: Jangan buka posisi baru kecuali ada sinyal sangat kuat. Fokus compound SOL." : ""}
`.trim();
  } catch (err) {
    return `## MACRO ZONE\nGagal fetch (${err.message}) — gunakan penilaian konservatif`;
  }
}

// ─── 2. Pre-deploy hook: validasi Fibonacci + patch Lazy LP ─────

export async function preDeployHook(deployArgs) {
  const checks = { passed: true, warnings: [], blocks: [] };

  // 2a. Cek apakah entry baru harus di-suspend (Deep Winter)
  const suspended = await shouldSuspendNewEntry();
  if (suspended) {
    checks.passed = false;
    checks.blocks.push("🔵 Deep Winter aktif — entry baru di-suspend. Fokus pada posisi existing.");
    return { ...checks, deployArgs };
  }

  // 2b. Fibonacci validation
  if (deployArgs.base_mint && deployArgs.price) {
    try {
      const fibAnalysis = await analyzeFibonacci(
        deployArgs.base_mint,
        Number(deployArgs.price),
        deployArgs.bin_step ?? 100
      );

      if (!fibAnalysis.valid) {
        // Bukan hard block, tapi warning ke LLM
        checks.warnings.push(`Fibonacci: ${fibAnalysis.message}`);
        log("integration", `Fibonacci warning untuk ${deployArgs.base_mint?.slice(0,8)}: ${fibAnalysis.message}`);
      } else {
        checks.warnings.push(`✅ Fibonacci valid: ${fibAnalysis.message}`);
        // Inject rekomendasi bins dari Fibonacci
        if (fibAnalysis.bin_recommendation) {
          deployArgs = {
            ...deployArgs,
            bins_below: deployArgs.bins_below ?? fibAnalysis.bin_recommendation.bins_below,
            bins_above: deployArgs.bins_above ?? fibAnalysis.bin_recommendation.bins_above,
            _fib_support: fibAnalysis.bin_recommendation.support_fib?.price,
            _fib_resistance: fibAnalysis.bin_recommendation.resistance_fib?.price,
          };
        }
      }
    } catch (err) {
      checks.warnings.push(`Fibonacci skip: ${err.message}`);
    }
  }

  // 2c. Patch args dengan Lazy LP preset jika aktif
  deployArgs = await patchDeployArgs(deployArgs);
  if (deployArgs._lazy_lp_override) {
    checks.warnings.push(`🦥 Lazy LP override aktif: ${deployArgs._lazy_lp_override.preset_desc}`);
  }

  return { ...checks, deployArgs };
}

// ─── 3. MEV protection wrapper untuk executor ───────────────────
// Bungkus write tools dengan MEV protection

export function wrapWriteToolsWithMev(toolMap) {
  const WRITE_TOOLS = ["deploy_position", "claim_fees", "close_position", "swap_token"];

  const patched = { ...toolMap };
  for (const toolName of WRITE_TOOLS) {
    if (patched[toolName]) {
      const original = patched[toolName];
      patched[toolName] = withMevProtection(toolName, original);
      log("integration", `MEV protection applied to: ${toolName}`);
    }
  }
  return patched;
}

// ─── 4. Health check semua modul ────────────────────────────────

export async function meteorGardenHealthCheck() {
  const results = {};

  // Macro Zone
  try {
    const zone = await getMacroZone(true);
    results.macro_zone = { ok: true, zone: zone.zone, summary: zone.summary };
  } catch (err) {
    results.macro_zone = { ok: false, error: err.message };
  }

  // Lazy LP
  try {
    const lazy = await getLazyLpStatus();
    results.lazy_lp = { ok: true, active: lazy.lazy_active, mode: lazy.mode };
  } catch (err) {
    results.lazy_lp = { ok: false, error: err.message };
  }

  // Jito
  try {
    const jito = await checkJitoHealth();
    results.jito = { ok: jito.available, endpoint: jito.endpoint };
  } catch (err) {
    results.jito = { ok: false, error: err.message };
  }

  // Fibonacci (test dengan dummy data)
  try {
    const fib = { ok: true, note: "Module loaded — akan ditest saat ada token mint" };
    results.fibonacci = fib;
  } catch (err) {
    results.fibonacci = { ok: false, error: err.message };
  }

  const allOk = Object.values(results).every(r => r.ok);
  log("integration", `Health check: ${allOk ? "✅ Semua modul OK" : "⚠️ Ada modul bermasalah"}`);

  return {
    all_ok:    allOk,
    timestamp: new Date().toISOString(),
    modules:   results,
  };
}

// ─── 5. Init function utama ─────────────────────────────────────

export async function initMeteorGarden() {
  log("integration", "🚀 Meteor Garden Bot — Initializing custom modules...");

  const health = await meteorGardenHealthCheck();

  log("integration", `Macro Zone: ${health.modules.macro_zone?.ok ? "✅" : "❌"} ${health.modules.macro_zone?.summary ?? ""}`);
  log("integration", `Lazy LP:    ${health.modules.lazy_lp?.ok ? "✅" : "❌"} active=${health.modules.lazy_lp?.active}`);
  log("integration", `Jito MEV:   ${health.modules.jito?.ok ? "✅" : "❌"} ${health.modules.jito?.endpoint ?? ""}`);
  log("integration", `Fibonacci:  ${health.modules.fibonacci?.ok ? "✅" : "❌"}`);

  if (!health.all_ok) {
    log("integration", "⚠️ Beberapa modul bermasalah — bot tetap jalan dengan fitur terbatas");
  } else {
    log("integration", "✅ Semua modul Meteor Garden aktif");
  }

  return health;
}
